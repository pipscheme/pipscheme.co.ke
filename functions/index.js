const functions = require('firebase-functions');
const admin = require('firebase-admin');

admin.initializeApp();

const db = admin.firestore();

const MPESA_BASE_URL = process.env.MPESA_BASE_URL || 'https://sandbox.safaricom.co.ke';
const CONSUMER_KEY = process.env.MPESA_CONSUMER_KEY;
const CONSUMER_SECRET = process.env.MPESA_CONSUMER_SECRET;
const SHORTCODE = process.env.MPESA_SHORTCODE;
const PASSKEY = process.env.MPESA_PASSKEY;
const CALLBACK_URL = process.env.MPESA_CALLBACK_URL;
const APP_URL = process.env.APP_URL || 'https://pipscheme.co.ke';

function makePassword(shortcode, passkey, timestamp) {
  return Buffer.from(`${shortcode}${passkey}${timestamp}`).toString('base64');
}

function normalizePhone(phone) {
  if (!phone) return null;
  let digits = String(phone).replace(/\D/g, '');
  if (digits.startsWith('0')) digits = '254' + digits.slice(1);
  if (digits.startsWith('7') || digits.startsWith('1')) digits = '254' + digits;
  return /^254[17]\d{8}$/.test(digits) ? digits : null;
}

async function getAccessToken() {
  if (!CONSUMER_KEY || !CONSUMER_SECRET) {
    throw new functions.https.HttpsError(
      'failed-precondition',
      'Daraja credentials are not configured. Set MPESA_CONSUMER_KEY and MPESA_CONSUMER_SECRET in Firebase functions config.'
    );
  }

  const auth = Buffer.from(`${CONSUMER_KEY}:${CONSUMER_SECRET}`).toString('base64');
  const response = await fetch(`${MPESA_BASE_URL}/oauth/v1/generate?grant_type=client_credentials`, {
    method: 'GET',
    headers: {
      Authorization: `Basic ${auth}`,
      'Content-Type': 'application/json',
    },
  });

  const result = await response.json();
  if (!response.ok || !result.access_token) {
    throw new functions.https.HttpsError('internal', 'Failed to get Daraja access token', result);
  }

  return result.access_token;
}

function createTimestamp(date = new Date()) {
  const pad = (n) => String(n).padStart(2, '0');
  return `${date.getFullYear()}${pad(date.getMonth() + 1)}${pad(date.getDate())}${pad(date.getHours())}${pad(date.getMinutes())}${pad(date.getSeconds())}`;
}

exports.createStkPush = functions.https.onCall(async (data, context) => {
  if (!context.auth || !context.auth.uid) {
    throw new functions.https.HttpsError('unauthenticated', 'User must be signed in to deposit money.');
  }

  const amount = Number(data && data.amount);
  const phoneNumber = normalizePhone(data && data.phoneNumber);

  if (!Number.isFinite(amount) || amount < 650) {
    throw new functions.https.HttpsError('invalid-argument', 'Amount must be at least KSh 650.');
  }

  if (!phoneNumber) {
    throw new functions.https.HttpsError('invalid-argument', 'Phone number must be a valid Kenyan mobile number.');
  }

  if (!SHORTCODE || !PASSKEY || !CALLBACK_URL) {
    throw new functions.https.HttpsError(
      'failed-precondition',
      'Missing Daraja config. Set MPESA_SHORTCODE, MPESA_PASSKEY, and MPESA_CALLBACK_URL in Firebase functions config.'
    );
  }

  const timestamp = createTimestamp();
  const password = makePassword(SHORTCODE, PASSKEY, timestamp);
  const token = await getAccessToken();

  const requestBody = {
    BusinessShortCode: String(SHORTCODE),
    Password: password,
    Timestamp: timestamp,
    TransactionType: 'CustomerPayBillOnline',
    Amount: String(Math.round(amount)),
    PartyA: phoneNumber,
    PartyB: String(SHORTCODE),
    PhoneNumber: phoneNumber,
    CallBackURL: CALLBACK_URL,
    AccountReference: 'PIPSCHEME',
    TransactionDesc: 'PIPSCHEME deposit'
  };

  const response = await fetch(`${MPESA_BASE_URL}/mpesa/stkpush/v1/processrequest`, {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${token}`,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify(requestBody),
  });

  const result = await response.json();
  if (!response.ok) {
    throw new functions.https.HttpsError('internal', 'STK Push request rejected by Daraja', result);
  }

  const userDoc = await db.collection('users').doc(context.auth.uid).get();
  const userData = userDoc.exists ? userDoc.data() : {};

  const depositDoc = {
    uid: context.auth.uid,
    email: context.auth.token.email || userData.email || null,
    amount: Math.round(amount),
    phoneNumber,
    status: 'pending',
    createdAt: admin.firestore.FieldValue.serverTimestamp(),
    checkoutRequestId: result.CheckoutRequestID || null,
    merchantRequestId: result.MerchantRequestID || null,
    source: 'stk',
    callbackUrl: CALLBACK_URL,
    appUrl: APP_URL,
    environment: MPESA_BASE_URL.includes('sandbox') ? 'sandbox' : 'production'
  };

  await db.collection('deposits').add(depositDoc);

  return {
    success: true,
    message: 'STK push request created successfully.',
    checkoutRequestId: result.CheckoutRequestID || null,
    merchantRequestId: result.MerchantRequestID || null,
  };
});

exports.mpesaCallback = functions.https.onRequest(async (req, res) => {
  const body = req.body || {};
  const callback = body && body.Body && body.Body.stkCallback ? body.Body.stkCallback : null;

  if (!callback) {
    res.status(400).json({ ResultCode: 1, ResultDesc: 'Missing callback payload' });
    return;
  }

  const resultCode = Number(callback.ResultCode);
  const resultDesc = callback.ResultDesc || 'Callback received';
  const checkoutRequestId = callback.CheckoutRequestID || null;
  const items = callback.CallbackMetadata && callback.CallbackMetadata.Item ? callback.CallbackMetadata.Item : [];

  const getItem = (name) => {
    const found = items.find((item) => item.Name === name);
    return found ? found.Value : null;
  };

  const amount = getItem('Amount');
  const mpesaReceiptNumber = getItem('MpesaReceiptNumber');
  const transactionDate = getItem('TransactionDate');
  const phone = getItem('PhoneNumber');

  try {
    if (checkoutRequestId) {
      const snapshot = await db
        .collection('deposits')
        .where('checkoutRequestId', '==', checkoutRequestId)
        .limit(1)
        .get();

      if (!snapshot.empty) {
        const deposit = snapshot.docs[0];
        const data = deposit.data();

        await deposit.ref.update({
          status: resultCode === 0 ? 'paid' : 'failed',
          resultCode,
          resultDesc,
          amountPaid: amount || data.amount || null,
          receiptNumber: mpesaReceiptNumber || null,
          transactionDate: transactionDate || null,
          phoneNumberPaid: phone || data.phoneNumber || null,
          updatedAt: admin.firestore.FieldValue.serverTimestamp(),
        });

        if (resultCode === 0 && data.uid) {
          await db.collection('users').doc(data.uid).update({
            paid: true,
            paidAt: admin.firestore.FieldValue.serverTimestamp(),
            lastDepositAmount: amount || data.amount || null,
            lastMpesaReceipt: mpesaReceiptNumber || null,
          });
        }
      }
    }

    res.status(200).json({
      ResultCode: 0,
      ResultDesc: 'Accepted'
    });
  } catch (error) {
    functions.logger.error('mpesaCallback error', error);
    res.status(500).json({
      ResultCode: 1,
      ResultDesc: 'Internal server error'
    });
  }
});

exports.healthCheck = functions.https.onRequest((req, res) => {
  res.status(200).json({ ok: true, service: 'pipscheme-mpesa', env: MPESA_BASE_URL.includes('sandbox') ? 'sandbox' : 'production' });
});

const { onCall, onRequest, HttpsError } = require('firebase-functions/v2/https');
const { defineSecret, defineString } = require('firebase-functions/params');
const { logger } = require('firebase-functions');
const admin = require('firebase-admin');

admin.initializeApp();
const db = admin.firestore();

// Credentials are Firebase Secret Manager values, never frontend config.
const mpesaConsumerKey = defineSecret('MPESA_CONSUMER_KEY');
const mpesaConsumerSecret = defineSecret('MPESA_CONSUMER_SECRET');
const mpesaPasskey = defineSecret('MPESA_PASSKEY');
const mpesaShortcode = defineString('MPESA_SHORTCODE');
const mpesaEnvironment = defineString('MPESA_ENVIRONMENT', { default: 'sandbox' });
const mpesaCallbackUrl = defineString('MPESA_CALLBACK_URL', {
  default: 'https://us-central1-pipscheme.cloudfunctions.net/mpesaCallback'
});

function getBaseUrl() {
  const environment = mpesaEnvironment.value().toLowerCase();
  if (environment === 'sandbox') return 'https://sandbox.safaricom.co.ke';
  if (environment === 'production') return 'https://api.safaricom.co.ke';
  throw new Error('MPESA_ENVIRONMENT must be sandbox or production.');
}

function getTimestamp() {
  const d = new Date();
  const pad = (n) => String(n).padStart(2, '0');
  return `${d.getFullYear()}${pad(d.getMonth() + 1)}${pad(d.getDate())}${pad(d.getHours())}${pad(d.getMinutes())}${pad(d.getSeconds())}`;
}

function normalizePhone(phone) {
  if (typeof phone !== 'string' && typeof phone !== 'number') return null;
  let digits = String(phone).replace(/\D/g, '');
  if (digits.startsWith('0')) digits = `254${digits.slice(1)}`;
  if (digits.startsWith('7') || digits.startsWith('1')) digits = `254${digits}`;
  return /^254[17]\d{8}$/.test(digits) ? digits : null;
}

function passwordFor(shortcode, passkey, timestamp) {
  return Buffer.from(`${shortcode}${passkey}${timestamp}`).toString('base64');
}

async function getAccessToken() {
  const auth = Buffer.from(`${mpesaConsumerKey.value()}:${mpesaConsumerSecret.value()}`).toString('base64');
  const response = await fetch(`${getBaseUrl()}/oauth/v1/generate?grant_type=client_credentials`, {
    headers: { Authorization: `Basic ${auth}` }
  });
  const body = await response.json();
  if (!response.ok || !body.access_token) {
    logger.error('Daraja OAuth failed', { status: response.status, response: body });
    throw new Error('Could not authenticate with Daraja. Check credentials and environment.');
  }
  return body.access_token;
}

async function queryTransaction(checkoutRequestId, shortcode) {
  const timestamp = getTimestamp();
  const token = await getAccessToken();
  const response = await fetch(`${getBaseUrl()}/mpesa/stkpushquery/v1/query`, {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${token}`,
      'Content-Type': 'application/json'
    },
    body: JSON.stringify({
      BusinessShortCode: String(shortcode),
      Password: passwordFor(shortcode, mpesaPasskey.value(), timestamp),
      Timestamp: timestamp,
      CheckoutRequestID: checkoutRequestId
    })
  });
  const body = await response.json();
  if (!response.ok) {
    logger.error('Daraja STK query failed', { status: response.status, response: body });
    throw new Error('Could not verify STK transaction with Daraja.');
  }
  return body;
}

exports.createStkPush = onCall({
  secrets: [mpesaConsumerKey, mpesaConsumerSecret, mpesaPasskey]
}, async (request) => {
  if (!request.auth) throw new HttpsError('unauthenticated', 'Sign in before starting a deposit.');

  const amount = Number(request.data && request.data.amount);
  const phoneNumber = normalizePhone(request.data && request.data.phoneNumber);
  if (!Number.isSafeInteger(amount) || amount < 650 || amount > 150000) {
    throw new HttpsError('invalid-argument', 'Amount must be a whole KSh amount between 650 and 150,000.');
  }
  if (!phoneNumber) throw new HttpsError('invalid-argument', 'Enter a valid Kenyan mobile number.');

  const shortcode = mpesaShortcode.value().trim();
  const callbackUrl = mpesaCallbackUrl.value().trim();
  if (!shortcode || !callbackUrl.startsWith('https://')) {
    throw new HttpsError('failed-precondition', 'Configure a valid shortcode and HTTPS callback URL.');
  }

  const timestamp = getTimestamp();
  const userRef = db.collection('users').doc(request.auth.uid);
  const userSnapshot = await userRef.get();
  const depositRef = db.collection('deposits').doc();
  await depositRef.set({
    uid: request.auth.uid,
    email: request.auth.token.email || (userSnapshot.exists ? userSnapshot.data().email : null) || null,
    amount,
    phoneNumber,
    status: 'pending',
    source: 'stk',
    createdAt: admin.firestore.FieldValue.serverTimestamp(),
    environment: mpesaEnvironment.value().toLowerCase()
  });

  try {
    const token = await getAccessToken();
    const response = await fetch(`${getBaseUrl()}/mpesa/stkpush/v1/processrequest`, {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${token}`,
        'Content-Type': 'application/json'
      },
      body: JSON.stringify({
        BusinessShortCode: String(shortcode),
        Password: passwordFor(shortcode, mpesaPasskey.value(), timestamp),
        Timestamp: timestamp,
        TransactionType: 'CustomerPayBillOnline',
        Amount: amount,
        PartyA: phoneNumber,
        PartyB: String(shortcode),
        PhoneNumber: phoneNumber,
        CallBackURL: callbackUrl,
        AccountReference: `DEP-${depositRef.id.slice(0, 10)}`,
        TransactionDesc: 'PIPSCHEME deposit'
      })
    });
    const body = await response.json();
    if (!response.ok || body.ResponseCode !== '0' || !body.CheckoutRequestID) {
      logger.error('Daraja STK request failed', { status: response.status, response: body });
      await depositRef.update({ status: 'failed', failureReason: 'Daraja rejected STK request', updatedAt: admin.firestore.FieldValue.serverTimestamp() });
      throw new HttpsError('internal', 'Daraja could not start the STK prompt. Please try the manual payment option.');
    }

    await depositRef.update({
      checkoutRequestId: body.CheckoutRequestID,
      merchantRequestId: body.MerchantRequestID || null,
      updatedAt: admin.firestore.FieldValue.serverTimestamp()
    });

    return { success: true, depositId: depositRef.id, message: 'STK prompt sent.' };
  } catch (error) {
    if (error instanceof HttpsError) throw error;
    logger.error('createStkPush error', error);
    await depositRef.update({ status: 'failed', failureReason: 'Unable to start STK request', updatedAt: admin.firestore.FieldValue.serverTimestamp() });
    throw new HttpsError('unavailable', 'STK Push is temporarily unavailable. You can use manual payment.');
  }
});

exports.mpesaCallback = onRequest({
  secrets: [mpesaConsumerKey, mpesaConsumerSecret, mpesaPasskey]
}, async (req, res) => {
  if (req.method !== 'POST') {
    res.status(405).json({ ResultCode: 1, ResultDesc: 'POST required' });
    return;
  }

  const callback = req.body && req.body.Body && req.body.Body.stkCallback;
  const checkoutRequestId = callback && callback.CheckoutRequestID;
  if (!callback || !checkoutRequestId) {
    res.status(400).json({ ResultCode: 1, ResultDesc: 'Invalid callback payload' });
    return;
  }

  try {
    const snapshot = await db.collection('deposits')
      .where('checkoutRequestId', '==', checkoutRequestId)
      .where('source', '==', 'stk')
      .limit(1)
      .get();

    if (snapshot.empty) {
      // Acknowledge only after the request is stored; retry if callback beat the Firestore update.
      res.status(503).json({ ResultCode: 1, ResultDesc: 'Transaction not ready; retry callback' });
      return;
    }

    const depositDoc = snapshot.docs[0];
    const deposit = depositDoc.data();
    const items = callback.CallbackMetadata && Array.isArray(callback.CallbackMetadata.Item)
      ? callback.CallbackMetadata.Item
      : [];
    const metadata = (name) => {
      const item = items.find((entry) => entry.Name === name);
      return item ? item.Value : null;
    };

    // Treat callbacks as untrusted notifications. Independently query Daraja before crediting.
    const queryResult = await queryTransaction(checkoutRequestId, mpesaShortcode.value().trim());
    const callbackCode = Number(callback.ResultCode);
    const queryCode = Number(queryResult.ResultCode);
    const paidAmount = Number(metadata('Amount'));
    const paidPhone = normalizePhone(String(metadata('PhoneNumber') || ''));
    const receipt = metadata('MpesaReceiptNumber');

    const verified = callbackCode === 0 && queryCode === 0 &&
      paidAmount === Number(deposit.amount) &&
      paidPhone === normalizePhone(deposit.phoneNumber) &&
      typeof receipt === 'string' && receipt.length > 0;

    if (!verified) {
      await depositDoc.ref.update({
        callbackReceivedAt: admin.firestore.FieldValue.serverTimestamp(),
        callbackResultCode: Number.isFinite(callbackCode) ? callbackCode : null,
        callbackResultDesc: String(callback.ResultDesc || '').slice(0, 300),
        darajaQueryResultCode: Number.isFinite(queryCode) ? queryCode : null,
        verificationStatus: 'not-confirmed',
        updatedAt: admin.firestore.FieldValue.serverTimestamp()
      });
      res.status(200).json({ ResultCode: 0, ResultDesc: 'Callback recorded; payment not confirmed' });
      return;
    }

    await db.runTransaction(async (transaction) => {
      const current = await transaction.get(depositDoc.ref);
      if (!current.exists || current.data().status === 'paid') return;
      transaction.update(depositDoc.ref, {
        status: 'paid',
        verificationStatus: 'verified-with-daraja-query',
        amountPaid: paidAmount,
        receiptNumber: receipt,
        phoneNumberPaid: paidPhone,
        transactionDate: metadata('TransactionDate') || null,
        callbackReceivedAt: admin.firestore.FieldValue.serverTimestamp(),
        updatedAt: admin.firestore.FieldValue.serverTimestamp()
      });
      transaction.set(db.collection('users').doc(deposit.uid), {
        paid: true,
        paidAt: admin.firestore.FieldValue.serverTimestamp(),
        lastDepositAmount: paidAmount,
        lastMpesaReceipt: receipt
      }, { merge: true });
    });

    res.status(200).json({ ResultCode: 0, ResultDesc: 'Payment verified' });
  } catch (error) {
    logger.error('mpesaCallback verification error', error);
    res.status(503).json({ ResultCode: 1, ResultDesc: 'Verification temporarily unavailable' });
  }
});

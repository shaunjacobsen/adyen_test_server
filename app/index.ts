import express, { Request, Response } from 'express';
import cors from 'cors';
import { Client, CheckoutAPI, hmacValidator } from '@adyen/api-library';
import { v4 as uuid } from 'uuid';
import * as jose from 'jose';

import adyenServer from './axios';
import { set } from './store';

const morgan = require('morgan');

require('dotenv').config();

const app = express();
const PORT = process.env.PORT || 3000;

app.use(
  cors({
    origin: process.env.CLIENT_URL || 'http://localhost:5173', // Replace with your frontend URL
    // methods: ['GET', 'POST', 'PUT', 'DELETE'], // Allowed HTTP methods
    // credentials: true, // Allow cookies if needed
  }),
);

app.use(morgan('combined'));

const adyenClient = new Client({
  apiKey: process.env.ADYEN_API_KEY ?? '',
  environment: 'TEST',
});

const checkout = new CheckoutAPI(adyenClient);

const determineHostUrl = (req: Request) => {
  let {
    'x-forwarded-proto': forwardedProto,
    'x-forwarded-host': forwardedHost,
  } = req.headers;

  if (forwardedProto && forwardedHost) {
    if (forwardedProto.includes(',')) {
      // @ts-ignore
      [forwardedProto] = forwardedProto.split(',');
    }

    return `${forwardedProto}://${forwardedHost}`;
  }

  return 'http://localhost:5173';
};

async function encryptCardDetails(
  cvc: any,
  number: any,
  expiryMonth: any,
  expiryYear: any,
) {
  const cert = process.env.ADYEN_X509 ?? '';
  const x509 = await jose.importX509(cert, 'RSA-OAEP-256');

  const dateTimeString = new Date().toISOString();
  const objectToEncrypt = JSON.stringify({
    cvc,
    number,
    expiryMonth, // 2 digit month
    expiryYear, // 4 digit year
    generationtime: dateTimeString,
  });

  const jwe = await new jose.CompactEncrypt(
    new TextEncoder().encode(objectToEncrypt),
  )
    .setProtectedHeader({ alg: 'RSA-OAEP-256', enc: 'A256GCM', version: '1' })
    .encrypt(x509);
  return jwe;
}

app.use(express.json());

app.post('/api/payment_methods', async (req: Request, res: Response) => {
  // here we could do some validation to check the cart items against inventory, check the shopper's info to see what
  // payment methods they are allowed to use, whether a certain payment method is allowed based on delivery type, etc.
  let allowedPaymentMethods = ['ideal'];
  req.body.amount.value > 1000 && allowedPaymentMethods.push('scheme');

  try {
    const response = await adyenServer.post('/paymentMethods', {
      merchantAccount: process.env.ADYEN_MERCHANT_ACCOUNT,
      allowedPaymentMethods,
      ...req.body,
    });

    return res.json(response.data);
  } catch (err: any) {
    console.log(err);
    console.error(`Error: ${err.message}, error code: ${err.errorCode}`);
    res.status(err.statusCode).json(err.message);
  }
});

app.post('/api/payments', async (req: Request, res: Response) => {
  // part 2 of the advanced checkout flow
  const { data, amount, reference, returnUrl } = req.body;

  const paymentRequest = {
    amount,
    reference,
    ...data,
    returnUrl,
    merchantAccount: process.env.ADYEN_MERCHANT_ACCOUNT || '',
  };

  const checkoutApi = new CheckoutAPI(adyenClient);
  const response = await checkoutApi.PaymentsApi.payments(paymentRequest, {
    idempotencyKey: uuid(),
  });

  return res.json(response);

  // try {
  //   const response = await adyenServer.post('/payments', {
  //     merchantAccount: process.env.ADYEN_MERCHANT_ACCOUNT,
  //     amount,
  //     reference,
  //     ...data,
  //     ...paymentMethod,
  //   });

  //   return res.json(response.data);
  // } catch (err: any) {
  //   console.log(err);
  //   console.error(`Error: ${err.message}, error code: ${err.errorCode}`);
  //   res.status(Number(err.status) ?? 500).json(err.message);
  // }
});

// step 3 of advanced flow
app.post('/api/payment_details', async (req: Request, res: Response) => {
  const { redirectResult } = req.body;
  const paymentDetailsRequest = {
    details: { redirectResult: decodeURI(redirectResult) },
  };

  const checkoutApi = new CheckoutAPI(adyenClient);
  const response = await checkoutApi.PaymentsApi.paymentsDetails(
    paymentDetailsRequest,
    { idempotencyKey: uuid() },
  );

  return res.json(response);
});

app.post('/api/session', async (req: Request, res: Response) => {
  try {
    const { order_reference, amount, items = [] } = req.body;

    if (!order_reference) throw new Error('No order reference provided');

    console.log(
      'Received payment request for order_reference: ' + order_reference,
    );

    // Ideally the data passed here should be computed based on business logic
    const response = await checkout.PaymentsApi.sessions({
      countryCode: 'NL',
      amount: { currency: 'EUR', value: amount },
      reference: order_reference,
      merchantAccount: process.env.ADYEN_MERCHANT_ACCOUNT ?? '',
      returnUrl: `${determineHostUrl(
        req,
      )}/post_payment?order_reference=${order_reference}`, // required for 3ds2 redirect flow
      lineItems: items,
    });

    // save transaction in memory
    // enable webhook to confirm the payment (change status to Authorized)
    const transaction = {
      amount: { currency: 'EUR', value: 1000 },
      paymentRef: order_reference,
      status: 'Pending',
    };

    set(order_reference, transaction);

    res.json(response);
  } catch (err: any) {
    console.log('err', err);
    console.error(`Error: ${err.message}, error code: ${err.errorCode}`);
    res.status(err.statusCode).json(err.message);
  }
});

app.post('/api/encrypt_card', async (req: Request, res: Response) => {
  const { cvc, number, expiryMonth, expiryYear } = req.body;
  const jwe = await encryptCardDetails(cvc, number, expiryMonth, expiryYear);

  return res.json(jwe).send();
});

// app.post('/api/payment', (req: Request, res: Response) => {

// });

app.post('/api/webhook', (req: Request, res: Response) => {
  console.log('Webhook received');
  console.dir(req.body, { depth: null });

  // this code was taken from https://github.com/adyen-examples/adyen-node-online-payments/tree/main/checkout-example
  const hmacKey = process.env.ADYEN_HMAC_KEY ?? '';
  const validator = new hmacValidator();

  const notificationRequest = req.body;
  const notificationRequestItems = notificationRequest?.notificationItems;

  // fetch first (and only) NotificationRequestItem
  const notification = notificationRequestItems[0]?.NotificationRequestItem;
  console.log('Notification: ', notification);

  // Handle the notification
  if (validator.validateHMAC(notification, hmacKey)) {
    // valid hmac: process event
    const merchantReference = notification.merchantReference;
    const eventCode = notification.eventCode;
    console.log(
      'merchantReference:' + merchantReference + ' eventCode:' + eventCode,
    );

    // do something like update db, this is up to the client

    // acknowledge event has been consumed
    res.status(202).send(); // Send a 202 response with an empty body
  } else {
    // invalid hmac
    console.log('Invalid HMAC signature: ' + notification);
    res.status(401).send('Invalid HMAC signature');
  }
});

app.listen(PORT, () => {
  console.log(`Server listening on port ${PORT}`);
});

import axios from 'axios';

require('dotenv').config();

const adyenInstance = axios.create({
  baseURL: process.env.ADYEN_DIRECT_URL,
  timeout: 1000,
  headers: { 'X-API-Key': process.env.ADYEN_API_KEY },
});

export default adyenInstance;

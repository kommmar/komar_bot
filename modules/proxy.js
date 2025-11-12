import { HttpsProxyAgent } from 'https-proxy-agent';
export const proxyAgent = process.env.PROXY_URL ? new HttpsProxyAgent(process.env.PROXY_URL) : null;

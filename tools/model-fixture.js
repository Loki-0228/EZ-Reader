/** Keep model discovery local in browser suites that use a test credential. */
export async function fulfillModelList(session, event, sessionId) {
  if (event.request.url !== 'https://api.deepseek.com/models') return false;
  await session.send('Fetch.fulfillRequest', { requestId:event.requestId, responseCode:200,
    responseHeaders:[{name:'Content-Type',value:'application/json'}],
    body:Buffer.from(JSON.stringify({data:[{id:'deepseek-flash'},{id:'deepseek-v4-pro'},{id:'deepseek-chat'}]})).toString('base64') }, sessionId);
  return true;
}

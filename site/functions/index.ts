// redirect / to /countdown until full launch
// remove this file when ready to go live
export const onRequest: PagesFunction = async () => {
  return Response.redirect(new URL('/countdown', 'https://daimon.network'), 302);
};

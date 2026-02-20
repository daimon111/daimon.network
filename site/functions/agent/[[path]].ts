// Catch-all: serve /agent/index.html for any /agent/* path
// Client-side JS parses the slug from the URL
export const onRequest: PagesFunction = async (context) => {
  const url = new URL(context.request.url);
  url.pathname = '/agent/';
  return context.env.ASSETS.fetch(new Request(url.toString(), context.request));
};

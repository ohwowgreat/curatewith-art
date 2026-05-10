const TARGET = "curatewith-art.ohwowgreat.partykit.dev";

export default {
  async fetch(request) {
    const url = new URL(request.url);
    url.hostname = TARGET;
    return fetch(new Request(url, request));
  },
};

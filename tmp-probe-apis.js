const axios = require('axios');

(async () => {
  const q = encodeURIComponent('United In Grief Kendrick Lamar');
  try {
    const r = await axios.get('https://saavn.dev/api/search/songs?query=' + q + '&limit=3', {
      timeout: 12000,
      validateStatus: () => true,
    });
    console.log('SAAVN_DEV status', r.status);
    console.log('SAAVN_DEV snippet', JSON.stringify(r.data).slice(0, 500));
  } catch (e) {
    console.log('SAAVN_DEV error', e.message);
  }

  try {
    const r = await axios.get('https://www.jiosaavn.com/api.php', {
      params: {
        __call: 'search.getResults',
        _format: 'json',
        _marker: 0,
        api_version: 4,
        ctx: 'web6dot0',
        q: 'United In Grief Kendrick Lamar',
        n: 5,
        p: 1,
      },
      timeout: 12000,
      headers: { 'User-Agent': 'Mozilla/5.0' },
      validateStatus: () => true,
    });
    console.log('JIOSAAVN status', r.status);
    console.log('JIOSAAVN snippet', JSON.stringify(r.data).slice(0, 800));
  } catch (e) {
    console.log('JIOSAAVN error', e.message);
  }

  try {
    const r = await axios.post(
      'https://www.youtube.com/youtubei/v1/search?prettyPrint=false',
      {
        context: { client: { clientName: 'WEB', clientVersion: '2.20240815.00.00' } },
        query: 'United In Grief Kendrick Lamar audio',
      },
      { timeout: 12000, validateStatus: () => true }
    );
    console.log('YT search status', r.status);
    const s = JSON.stringify(r.data);
    const m = s.match(/"videoId":"([^"]+)"/);
    console.log('YT first videoId', m && m[1]);
  } catch (e) {
    console.log('YT search error', e.message);
  }
})();

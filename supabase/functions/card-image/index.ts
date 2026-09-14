// Proxy de imágenes de producto Cardmarket para la app "Mis Cartas Pokémon".
// El CDN de Cardmarket (CloudFront) rechaza peticiones sin Referer propio,
// así que el navegador no puede hotlinkear; esta función añade el Referer.
// Solo sirve ese host y ese patrón de ruta: no es un proxy genérico.
// Ojo: Cardmarket guarda las imágenes en S3 con un Content-Type roto
// ("multerS3.AUTO_CONTENT_TYPE"), así que servimos siempre image/jpeg.
Deno.serve(async (req) => {
  const url = new URL(req.url);
  const set = url.searchParams.get('set') || '';
  const product = url.searchParams.get('product') || '';
  if (!/^[a-z0-9.]{2,20}$/.test(set) || !/^\d{3,10}$/.test(product)) {
    return new Response('bad params', { status: 400 });
  }
  const upstream = `https://product-images.s3.cardmarket.com/51/${set}/${product}/${product}.jpg`;
  let r: Response;
  try {
    r = await fetch(upstream, {
      headers: { Referer: 'https://www.cardmarket.com/', 'User-Agent': 'Mozilla/5.0' },
    });
  } catch {
    return new Response('upstream error', { status: 502 });
  }
  if (!r.ok) return new Response('not found', { status: 404 });
  return new Response(r.body, {
    headers: {
      'Content-Type': 'image/jpeg',
      'Cache-Control': 'public, max-age=86400',
      'Access-Control-Allow-Origin': '*',
    },
  });
});

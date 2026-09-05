/**
 * BelascoAuto — İlan linki paylaşım önizlemesi (Open Graph) sunucu tarafı fonksiyonu
 * ---------------------------------------------------------------------------
 * Ne işe yarar?
 *  - Bir ilan linki (https://siteniz.com/?ad=482) Discord/WhatsApp/Twitter/Telegram
 *    gibi bir platforma yapıştırıldığında, o platformun "bot"u bu linke gelir ve
 *    JavaScript ÇALIŞTIRMADAN sadece <head> içindeki meta etiketlerini okur.
 *  - Bu fonksiyon, isteğin bir "bot"tan mı yoksa normal bir tarayıcıdan mı geldiğini
 *    User-Agent'a bakarak anlar:
 *      • Bot ise ve ?ad=... varsa  -> Firebase Realtime Database'den o ilanı çeker,
 *        ilana özel başlık/açıklama/fotoğraf ile küçük bir HTML döner.
 *      • Normal kullanıcı ise      -> Sitenin gerçek index.html dosyasını olduğu
 *        gibi döner (kullanıcı deneyiminde HİÇBİR değişiklik olmaz).
 *
 * Kurulum:
 *  1) Bu dosyayı ve package.json'ı Firebase projenizdeki "functions" klasörüne koyun.
 *  2) Sitenizin GÜNCEL index.html dosyasını "functions/public/index.html" olarak kopyalayın.
 *     (Yani sitenizi güncelleyince bu kopyayı da güncellemeniz gerekir.)
 *  3) Proje kökünüzdeki firebase.json dosyasını bu paketle gelen firebase.json ile
 *     birleştirin (rewrites kısmı önemli).
 *  4) Terminalde:  firebase deploy --only functions,hosting
 */

const { onRequest } = require("firebase-functions/v2/https");
const { initializeApp } = require("firebase-admin/app");
const { getDatabase } = require("firebase-admin/database");
const fs = require("fs");
const path = require("path");

initializeApp({
  databaseURL: "https://beamng-ilan-default-rtdb.europe-west1.firebasedatabase.app",
});

// Gerçek sitenizin index.html içeriği (deploy sırasında bu dosyayla birlikte paketlenir).
const INDEX_HTML_PATH = path.join(__dirname, "public", "index.html");
let cachedIndexHtml = null;
function getIndexHtml() {
  if (cachedIndexHtml === null) {
    cachedIndexHtml = fs.readFileSync(INDEX_HTML_PATH, "utf8");
  }
  return cachedIndexHtml;
}

// Bilinen link-önizleme botlarının User-Agent imzaları.
const BOT_UA_REGEX =
  /discordbot|twitterbot|facebookexternalhit|whatsapp|telegrambot|slackbot|linkedinbot|pinterest|embedly|quora link preview|redditbot|applebot|skypeuripreview|vkshare|flipboard|w3c_validator|googlebot|bingbot|yandex/i;

function escapeHtml(str) {
  return String(str || "")
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");
}

function buildOgHtml({ title, description, image, url }) {
  const safeTitle = escapeHtml(title);
  const safeDesc = escapeHtml(description);
  const safeImage = escapeHtml(image);
  const safeUrl = escapeHtml(url);
  return `<!DOCTYPE html>
<html lang="tr">
<head>
<meta charset="UTF-8" />
<title>${safeTitle}</title>
<meta name="description" content="${safeDesc}" />

<!-- Discord / Facebook / WhatsApp vb. -->
<meta property="og:type" content="website" />
<meta property="og:title" content="${safeTitle}" />
<meta property="og:description" content="${safeDesc}" />
${safeImage ? `<meta property="og:image" content="${safeImage}" />` : ""}
<meta property="og:url" content="${safeUrl}" />
<meta property="og:site_name" content="BelascoAuto" />

<!-- Twitter -->
<meta name="twitter:card" content="${safeImage ? "summary_large_image" : "summary"}" />
<meta name="twitter:title" content="${safeTitle}" />
<meta name="twitter:description" content="${safeDesc}" />
${safeImage ? `<meta name="twitter:image" content="${safeImage}" />` : ""}

<!-- Bot içeri tıklarsa (nadir) gerçek siteye yönlendir -->
<meta http-equiv="refresh" content="0; url=${safeUrl}" />
<link rel="canonical" href="${safeUrl}" />
</head>
<body>
  <p>${safeTitle}</p>
  <p><a href="${safeUrl}">İlanı görüntülemek için tıklayın</a></p>
</body>
</html>`;
}

exports.ssrAdMeta = onRequest({ region: "europe-west1" }, async (req, res) => {
  try {
    const userAgent = req.get("user-agent") || "";
    const isBot = BOT_UA_REGEX.test(userAgent);
    const adParam = req.query.ad || req.query.ilan || null;

    // Normal kullanıcı VEYA ilan linki değilse -> siteyi olduğu gibi göster.
    if (!isBot || !adParam) {
      res.set("Cache-Control", "public, max-age=300");
      res.status(200).send(getIndexHtml());
      return;
    }

    // Bot + ilan linki -> Realtime Database'den ilanı bul.
    const db = getDatabase();
    const adIdStr = String(adParam);
    let adSnap = null;

    if (/^\d+$/.test(adIdStr)) {
      // Kısa ID (shortId) ile arama
      const q = await db
        .ref("ads")
        .orderByChild("shortId")
        .equalTo(Number(adIdStr))
        .limitToFirst(1)
        .once("value");
      if (q.exists()) {
        q.forEach((child) => {
          adSnap = child.val();
        });
      }
      if (!adSnap) {
        const q2 = await db
          .ref("ads")
          .orderByChild("shortId")
          .equalTo(adIdStr)
          .limitToFirst(1)
          .once("value");
        if (q2.exists()) {
          q2.forEach((child) => {
            adSnap = child.val();
          });
        }
      }
    }
    if (!adSnap) {
      // Eski uzun ID ile doğrudan arama
      const direct = await db.ref("ads/" + adIdStr).once("value");
      if (direct.exists()) adSnap = direct.val();
    }

    if (!adSnap) {
      // İlan bulunamadı -> siteyi normal göster.
      res.set("Cache-Control", "public, max-age=60");
      res.status(200).send(getIndexHtml());
      return;
    }

    const title = adSnap.title || "İlan";
    const descParts = [
      adSnap.brand,
      adSnap.model,
      adSnap.year ? adSnap.year + " model" : null,
      adSnap.km ? Number(adSnap.km).toLocaleString("tr-TR") + " km" : null,
      adSnap.hp ? adSnap.hp + " HP" : null,
    ].filter(Boolean);
    const description =
      adSnap.description ? String(adSnap.description).slice(0, 160) : descParts.join(" • ") || "BelascoAuto ilan detayı";
    const image =
      (Array.isArray(adSnap.images) && adSnap.images.length
        ? adSnap.images[adSnap.thumbnailIndex || 0] || adSnap.images[0]
        : null) || null;
    const url = `${req.protocol}://${req.get("host")}/?ad=${encodeURIComponent(adIdStr)}`;

    res.set("Cache-Control", "public, max-age=600");
    res.status(200).send(
      buildOgHtml({
        title: `${title}${adSnap.brand ? " — " + adSnap.brand + (adSnap.model ? " " + adSnap.model : "") : ""}`,
        description,
        image,
        url,
      })
    );
  } catch (err) {
    console.error("ssrAdMeta hata:", err);
    res.set("Cache-Control", "no-store");
    res.status(200).send(getIndexHtml());
  }
});

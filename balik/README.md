# Engin Balık Tut

Silivri–Eceabat arası kıyıdan av için saatlik tahmin modeli. Hedef türler: mırmır, çipura, levrek, karagöz, sargoz, lüfer (sarıkanat / lüfer / kofana) ve zargana.

**Skor = 100 × Mevsim × Habitat × Koşul uyumu × Uygulanabilirlik**

Bütün parametreler uygulamanın Model sekmesinden görülebilir ve değiştirilebilir. Av günlüğüne girilen başarılı ve boş seanslar, faktör ağırlıklarının kalibrasyonunda kullanılır.

## Kurulum (GitHub Pages)

1. Bu klasördeki dosyaları bir GitHub reposunun köküne yükle.
2. Repoda Settings → Pages → Branch: `main` / root seçip kaydet.
3. Telefonda `https://<kullanıcı>.github.io/<repo>/` adresini Safari'de aç ve Paylaş menüsünden "Ana Ekrana Ekle"yi seç.

## Veri kaynakları

- Open-Meteo Forecast API ve Marine API (ücretsiz, API anahtarı gerekmez)
- Güneş ve ay konumu cihazda SunCalc algoritmasıyla hesaplanır.

## Dosyalar

| Dosya | Görevi |
|---|---|
| `index.html` | Uygulamanın tamamı (model, arayüz, grafik) |
| `sw.js` | Çevrimdışı açılış için önbellek |
| `manifest.webmanifest`, `*.png` | Ana ekran ikonu ve uygulama bilgisi |

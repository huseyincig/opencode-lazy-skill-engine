# Bağımsız çalışma ve eklentilerle birlikte kullanım

Bu eklenti başka bir orkestratörü **tanımak zorunda değildir**. Hostun V2 oturum, ajan, skill ve araç kapasitelerine göre iş görür.

## Standalone

`mode: auto` ve varsayılan `autoBind: adaptive`: normal bir tek ajan oturumunda yalnız yüksek güvenli native skill'leri bağlar. İlgisiz sorgularda ekleme yoktur. İstenirse `mode: single` ile bu mantık sabitlenir. Katalog görünümü değiştirilmez.

## Çok ajanlı ortam

- Host `session.get` içindeki `parentID` alanı mevcutsa alt ajan algılanır.
- Host ajan listesindeki uzman rolün sınırlayıcı `skill` kuralları çok ajanlı çalışma için sinyal kabul edilir. Özel ana ajan/rol adı aranmaz.
- Varsayılan `adaptive` modu yönetici oturumuna zorla skill bağlamaz; worker için yetki/rol kapsamındaki adayları değerlendirir.
- Hostun `agent.list` izinleri görülebiliyorsa sıralı `action/resource/effect` kuralları `allow` dışında bir sonuç verirse otomatik seçim dışı bırakılır. Bunu native hostun tüm izinlerini yeniden uygulamak için değil, **kendi ürettiğimiz ekleri daraltmak** için yaparız.
- Başka bir plugin `prompt.skills` oluşturmuşsa `coexistence: respect` yeni otomatik seçimi durdurur. `requiredSkills` ve açık kullanıcının seçimi atomik olarak yönetilir.
- Diğer eklentilerin `ctx.skill.transform`, `ctx.agent.transform`, görev yönetimi ve sistem promptları değiştirilmez.

## Kurulum örnekleri (sürümsüz ve markasız)

Standart kullanım:

```jsonc
{"plugins":[{"package":"./plugins/lazy-skills"}]}
```

Yalnız keşif; başka bir bağlayıcı tüm otomatik skill seçimlerini yönetiyorsa:

```jsonc
{"plugins":[{"package":"./plugins/lazy-skills","options":{"autoBind":"off","nativeCatalog":"preserve","hints":"off"}}]}
```

Katalog ve ipuçları ayrı etkinleştirilebilir:

```jsonc
{"plugins":[{"package":"./plugins/lazy-skills","options":{"nativeCatalog":"hide","hints":"hint"}}]}
```

Son örneği başka bir skill kataloğu kaydedicisiyle birlikte kullanmadan önce test edin. `hide` native katalog kayıtlarının `autoinvoke` alanını etkiler ve başka eklentinin beklentisiyle çakışabilir.

## Sınırlar

1. Eklenti isim/versiyon bazlı orkestratör algılamaz. Bir ekleme kancasının kendisinden **sonra** çalışan başka plugin'in yapacağı değişikliği önceden bilemez. Kesin tek-sahiplik gerekiyorsa kendi `autoBind` seçeneğini `off` yapın.
2. Ajan kataloğunda görünmeyen oturum-başına izin değişiklikleri, hosttan ayrı bir yetkilendirme API'si olmadıkça kesin doğrulanamaz; native host gerçek güvenlik sınırıdır.
3. Rol tanımı verilmezse özel bir ajan adı varsayılmaz. `roles` girilirse yalnız o rollerin otomatik izin havuzları kullanılır.
4. `requiredSkills` kullanılıyorsa görevi yöneten sistemin bu metadatayı iletmesi gerekir. Otomatik olarak başka bir projenin görev kayıtlarından okunmaz.
5. Canlı ortak hostta önce `opencode plugin list` ve native `skill` davranışları, sonra iki yükleme sırası, yönetici/worker, izin deny/allow, compaction ve reload akışları doğrulanmalıdır.

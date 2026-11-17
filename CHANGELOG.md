# Changelog

## 1.4.2

- `mode: single` ve `autoBind: off` altında `ctx.agent.list()` mevcutken `session.get` üzerinden host izinlerinin (`respectHostPermissions`) tutarlı biçimde uygulanması ve geçici ağ/zaman aşımı hatalarında fail-closed davranışı.
- `skill:<id>` açık bağlamasının `vaultAutoBind: false` veya `projectAutoBind: false` sınırlarını aşmasının engellenmesi; `lazy_skill_plan` aracının `prompt` kancası ile tam izin/kapsam paritesi.
- CJK (Çince/Japonca) sorgularda kavram eşleşmesi varken alan terimlerinin korunması, CJK çok kelimeli `negativeTriggers` eşleşmesi, UTF-16 maske hizalaması ve tam eşleşme (`complete`) sonrası kalan `topK` yuvalarının kısmi (`partial`) sonuçlarla doldurulması.
- `detectLanguage` içinde Türkçe `İ` harfi ve tekrar eden alt dizgi düzeltmesi; `parseQuery` ve `extractExplicit` için `maxPromptChars` uyumu; `triggers`/`tags` alanlarının tırnak içi ifade aramasına eklenmesi.
- `options.roots` altındaki proje içi dizinlerin `origin: 'project'` olarak sınıflandırılması, `listResources` sembolik bağ/Windows yol ayracı düzeltmesi, `safeRead` `trustedRoot` kanonikleştirmesi ve `<skill>` / `<vault_resource>` / `<lazy_bound_skill>` XML sınır kaçış koruması.
- `nativeCatalog: 'compact'` yeniden yüklemelerinde orijinal açıklamaların korunması, `Catalog.refresh(true)` yarış durumu düzeltmesi, `parseFrontmatter` UTF-8 BOM/boşluk desteği ve `SessionLedger` yükleme anahtarı hizalaması.

## 1.4.1

- Kod, yorum, testler, belgeler ve kurulum örneklerindeki özel dış proje veya ürün atıfları temizlendi.
- Yalnız `opencode-lazy-skill-engine` ve resmi OpenCode arayüzü ürün adı olarak kullanılıyor.
- Gerekli çalışma zamanı importları, test komutları, SDK paket tanımlayıcısı ve özgün lisans korundu.
- Tek ajan, çok ajanlı çalışma, skill arama ve izin sözleşmelerinde işlevsel değişiklik yapılmadı.

## 1.4.0

- Dış orkestratör kimliği ve sürüm numarası bağımlılığı olmadan host yetkinliği temelli ortak çalışma.
- Varsayılan `nativeCatalog: preserve`, `hints: off`, `coexistence: respect`.
- `ctx.agent.list()` izinlerine dayalı otomatik skill filtrelemesi; sıralı allow/ask/deny ve wildcard kuralları.
- Mevcut `prompt.skills` ekleri başka bir sistemin sahipliğinde sayılır; otomatik ekleme varsayılan olarak durdurulur.
- Host ajan listesi mevcut fakat alt ajan yetkisi doğrulanamıyorsa otomatik genişleme engellenir.
- Ortak eklenti ortamındaki uzman skill kısıtlamalarından çok ajanlı modun sezilmesi.
- Versiyon sabitlemeyen örnek kurulum yolu; diğer projelere bağımlı belgelerin paket yüzeyinden temizlenmesi.
- Eski seçim, arama, dil, güvenlik ve vault özellikleri korunur.

Previous releases supplied the multilingual index, role-aware selection, native binding, cold vault, semantic fallback and standalone auto mode. See the tests for ongoing compatibility contracts.

# Mimari

`src/core/` her orkestratörden bağımsız saf veya sınırlı I/O modülleridir. `src/plugin.js` OpenCode V2 adaptörüdür.

- **Katalog**: native `ctx.skill.list()` ve opt-in yerel vault kökleri; native kayıt aynı ID'li vault'a önceliklidir. Proje dizini içindeki özel `roots` yolları da `project` kökenli sayılır. Bounded metadata ve atomik indeks yenileme kullanılır.
- **Arama**: Unicode normalizasyonu, script-aware parçalama, 13 dilli kavramlar (CJK alan terimleri korunarak), ters indeks, ağırlıklı eşleşme ve tam eşleşme öncelikli sınırlı Top-K.
- **Seçim**: zorunlu/açık seçim önceliği, otomatik aday allowlist'i, negatif tetikleyici (CJK boşluksuz ifadeler dahil), kaynak çarpanı ve coverage/eşik; `lazy_skill_plan` ile `prompt` kancası birebir hizalıdır.
- **Host izinleri**: `src/core/host-policy.js` yalnız hostun ajan listesindeki sıralı skill kurallarını okur; wildcard eşleşmesi lineerdir. `mode: single` ve `autoBind: off` dahil olmak üzere host ajan listesi mevcutsa oturum kimliği okunur; geçici hatalarda fail-closed davranılır. Katalog listeleme TTL ile sınırlandırılır.
- **Birlikte çalışma**: başkasına ait `prompt.skills` dizisi korunur; varsayılan mod yeni otomatik ek yapmaz. Katalog gizleme ve prompt mikro-ipuçları opt-in'dir.
- **Bağlama**: Native skill'ler `event.prompt.skills` ile, vault içerikleri opt-in ve bounded dosya okumasıyla eklenir; XML sınır etiketleri kaçışlanır. Dosya ve role geçişleri farklı koruma katmanlarıdır.
- **Semantik seçim**: kapalı varsayılan; native `experimental.generate.text` yeteneği varsa sınırlı adaylardan strict JSON ID dönüşü ve LRU sonuç önbelleği.

Hiçbir orkestratörün isimli API'si, sürüm koşulu, sabit rol modeli, ağ erişimi, veritabanı veya komut yürütme motoru gerekmiyor. Tek kontrollü runtime bağımlılığı V2 host API sözleşmesidir.

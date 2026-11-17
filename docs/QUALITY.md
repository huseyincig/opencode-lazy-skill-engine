# Kalite durumu

Çalıştırma hedefi: OpenCode V2 Promise server plugin. Yerel doğrulama: standart `node:test` çalıştırıcısı, taklit host, bağımlılıksız çekirdek. Paket sürüm metadatası dışında sabit host yama sürümü bağımlılığı yoktur.

| Test / kapı | Kanıt | Durum |
|---|---|---|
| 13 dilli arama | `tests/multilingual.test.js`, `tests/dual-mode.test.js` | Yerel test |
| Native/Vault güvenlik | `tests/scanner-security.test.js`, `tests/plugin.test.js` | Yerel test |
| Bağımsız tek ajan / çok ajan | `tests/dual-mode.test.js` | Taklit host |
| Ortak çalışma, izinler, mevcut ekler | `tests/coexistence.test.js` | Taklit host |
| Sıralama ve en iyi K sonuçları | `tests/text-rank.test.js`, `tests/robustness.test.js` | Yerel test |
| Zorunlu/açık seçim, semantik fallback | `tests/selection-parity.test.js` | PASS (Yerel test) |
| Güvenlik, CJK, izin ve yaşam döngüsü regresyonları | `tests/regression-audit.test.js` | PASS (Yerel test) |
| Sözdizimi ve tüm birim testleri | `npm run check` | PASS (Yerel kontrol) |
| Paket dosya yüzeyi | `npm pack --dry-run` | PASS (Yerel kontrol) |
| Sandbox OpenCode V2 eklenti yükleme ve `setup(ctx)` | `opencode v2.3.0 --standalone debug agents` | PASS (Yalıtılmış sandbox) |
| Birden fazla eklentiyle canlı yükleme sırası ve çok turlu oturum | Canlı çok eklentili oturum testi yapılmadı | **NOT_RUN** |

Statik sözleşme okuması ve taklit host geçişi gerçek host uygulamasının bütün yaşam döngüsünü kanıtlamaz. Paket/arşiv kontrollerinin sonuçları sürümün teslimi sırasında tazelenmelidir.

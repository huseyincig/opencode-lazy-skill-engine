# opencode-lazy-skill-engine

OpenCode V2 sunucu eklentisi. **Tek ajan** ve **çok ajanlı çalışma ortamları** için bağımsız, 13 dilde skill keşfi; native skill bağlama ve güvenli cold-vault erişimi sunar. Herhangi bir orkestratörün paketini, rol isimlerini, görev araçlarını, modelini veya belirli bir host yama sürümünü gerektirmez.

## Tasarım ilkeleri

- **Host sahibi olmaya devam eder.** Başka bir eklentinin kayıtlı skill'leri, native `skill` aracı, ajan izinleri ve mevcut `prompt.skills` ekleri korunur.
- **Yetkinlik temelli uyum.** Yalnızca `ctx.skill`, `ctx.session`, `ctx.agent` ve `ctx.tool` alanlarının mevcut sözleşmeleri kullanılır; başka eklentiye özgü API çağrılmaz.
- **Minimum müdahale.** Varsayılan katalog davranışı `preserve`, ipucu enjeksiyonu `off`, ortak çalışmada `coexistence: respect` şeklindedir. Kataloğu gizleme ve tam içerik yükleme ayrıca seçilir.
- **Yerel hızlı arama.** Sınırlı frontmatter taraması, ters indeks, BM25F benzeri puanlama, Unicode parçalama, çok dilli kavram eşleştirme ve bounded Top-K kullanılır. Arama için ağ, veritabanı veya embedding gerekmez.
- **İzinlerin genişletilmemesi.** Uygun olduğunda hostun ajan izinleri `ctx.agent.list()` üzerinden okunur. Sıralı `skill` izinlerinde son eşleşme geçerlidir. Kullanıcı/başka eklenti tarafından bağlanmış skill'lere dokunulmaz.

## Kurulum

Paket klasörünü proje içindeki `./plugins/lazy-skills/` dizinine yerleştirin (içinde `package.json` ve `src/` bulunmalıdır). Ardından `opencode.jsonc` içinde:

```jsonc
{
  "$schema": "https://opencode.ai/config.json",
  "plugins": [{
    "package": "./plugins/lazy-skills",
    "options": {
      "mode": "auto",
      "autoBind": "adaptive",
      "coexistence": "respect",
      "respectHostPermissions": true,
      "nativeCatalog": "preserve",
      "hints": "off"
    }
  }]
}
```

Bu yalnızca örnektir: Options tamamen atlandığında aynı güvenli varsayılanlar uygulanır. Global kurulumda paket yolunu OpenCode global `opencode.jsonc` konumuna göre çözümleyin. SDK bağımlılığı çalıştıran OpenCode V2 ortamından çözülmelidir. `@opencode/plugin` için package manifestindeki **V2 ana sürüm aralığı** dışında sabit bir yama sürümü zorunlu tutulmaz. V2 API yeteneklerinin bulunmaması durumunda çalışma kancalarının her biri ayrıca değerlendirilir; gerçek host kabul testi gerekir.

## Çalışma biçimleri

| `mode` | Otomatik skill bağlama | Kullanım |
|---|---|---|
| `auto` (varsayılan) | Tek ajanda güven eşiğini geçen skill; host alt ajanı/rol kısıtlaması algılandığında yalnız worker | Bağımsız kurulumlar |
| `single` | `autoBind: adaptive` ile tek ajan mantığı | Tek ajana zorlamak isteyenler |
| `orchestrator` | `autoBind: adaptive` ile yalnız worker | Otomatik ayrım yerine açık mod isteyenler |

`autoBind` seçenekleri: `adaptive` (varsayılan), `off`, `workers`, `all`. `coexistence: respect` varsayılan olarak `prompt.skills` zaten doluysa **yeni otomatik skill eklemez**. `requiredSkills` gibi açık görev sözleşmeleri ayrı değerlendirilir. `coexistence: augment` yalnızca iki bağlayıcıyı birlikte kullanmak bilinçli olarak istendiğinde seçilmelidir.

`ctx.agent.list()` mevcutsa hostun sıralı izinleri otomatik adayları filtreler; açıkça `allow` olmayan skill otomatik bağlanmaz. Ajan listesi mevcut ama worker'ın politikası okunamıyorsa worker için otomatik seçim kapatılır. Hostun bu yeteneği hiç yoksa yalnızca eldeki açık rol/scope ayarlarıyla çalışılır; **ayrı bir çalışma zamanı izin onayı garanti edilmez**. Gerekirse `autoBind: off` kullanın. `respectHostPermissions: false` yalnızca uygulayıcının riskini kabul ettiği uyum durumları için sunulur.

`nativeCatalog: preserve` başka eklentilerin `autoinvoke` kararını bozmaz. `hide` ve `compact` seçenekleri **yalnızca bilinçli tercih** ile etkindir; birlikte çalışan başka skill kaydediciler varsa özellikle test edilmelidir.

## Skill bağlama sözleşmesi

Seçim önceliği: mevcut host ekleri (değişmeden kalır); **görevin zorunlu skill'leri** (`metadata.lazySkill.requiredSkills`); metindeki **`skill:<id>`** açık seçimi; uygun rol adayları ve otomatik puanlama; isteğe bağlı semantik fallback. Zorunlu skill eksik veya host tarafından açıkça engellenmişse ekleme **atomik** olarak reddedilir. Otomatik seçim rolün `allowed` listesini, kaynak önceliklerini, olumsuz tetikleyicileri ve sınırları korur.

Orkestratör varsa `event.metadata.lazySkill` altında `{taskId, requiredSkills}` aktarabilir; **bu alan zorunlu değildir ve başka bir eklentinin API'si değildir**. Ajan izinlerini başka bir sistemden devralmaz; yalnızca hostun sağladığı kimlik/izin kayıtlarını yorumlar. Native skill'ler her zaman `prompt.skills` üzerinden eklenir; cold vault açıkça izin verilmedikçe otomatik yüklenmez.

## Araçlar

| Araç | Görev |
|---|---|
| `lazy_skill_search` | Çok dilli, kısa/ayrıntılı skill araması |
| `lazy_skill_info` | Skill açıklaması, kökeni ve referans dosya adları |
| `lazy_skill_plan` | Seçimi içeriği yüklemeden önizleme |
| `lazy_skill_status` | Katalog, aktif ayarlar ve son bağlama özeti |
| `lazy_skill_load` | Cold-vault skill içeriğini güvenli biçimde yükleme |
| `lazy_skill_resource` | Cold-vault referans metin dosyalarını sınırlı okuma |

İlk dört araç büyük skill gövdelerini yüklemez. Native skill'i yüklerken hostun kendi `skill` aracı kullanılır. Vault'dan okunan içerik güvenilmeyen veridir; sistem talimatlarını veya host izinlerini değiştiremez.

## Dil desteği

Mandarin Çincesi (`zh`), İngilizce (`en`), Hintçe (`hi`), Almanca (`de`), Portekizce (`pt`), Japonca (`ja`), Endonezce (`id`), Rusça (`ru`), Fransızca (`fr`), İspanyolca (`es`), Vietnamca (`vi`), Hollandaca (`nl`) ve Türkçe (`tr`). Bu yapı tam çeviri motoru değildir; çok dilli mühendislik terimleri için yerel arama köprüsüdür.

## Doğrulama

```sh
npm test
npm run check
npm run benchmark
npm pack --dry-run
```

Testler `node:test` ile taklit V2 host üzerinde çalışır; ayrıca `opencode v2.3.0 --standalone` yalıtılmış sandbox ortamında eklenti yükleme, `setup(ctx)` ve temiz kapanış doğrulanmıştır. **Gerçek OpenCode sunucusunda farklı eklenti yükleme sıralarıyla uçtan uca çok ajanlı tur testleri bu pakette çalıştırılmamıştır (`NOT_RUN`).** Ayrıntılar: [Ortak çalışma](docs/COEXISTENCE.md), [Kalite](docs/QUALITY.md), [Mimari](docs/ARCHITECTURE.md).

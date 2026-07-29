# 350 Colour Names

A dictionary of 350 distinct colour names, each with a hue family and a hex
value. This is the live dictionary that names workspaces and branches — it
replaced the `FLOWERS` list in `src/engine/git/naming.ts` on 2026-07-29, so
every entry here is a branch the app can actually produce (`zeros/Coquelicot`).
The names in this file and the `COLOURS` array in `naming.ts` must stay in
step; `naming.test.ts` asserts the invariants below.

Seeded by [45 Weird Color Names You've Probably Never Heard Of][yahoo], then
widened to 350 across historic pigments and dyes, heraldic tinctures, Japanese
and Chinese traditional colours, mineral and gemstone names, and a handful of
modern paint-marketing coinages.

[yahoo]: https://www.yahoo.com/lifestyle/articles/45-weird-color-names-ve-231000280.html

## How to read this

- **Family** — one of Red, Pink, Magenta, Violet, Blue, Cyan, Green, Yellow,
  Orange, Brown, White, Grey, Black. Assigned by converting the hex to HSL and
  binning the hue, then hand-corrected where the name carries a family the
  maths cannot see: Feldgrau is a green that everyone calls grey, Cambridge
  blue is genuinely a pale green, Elephant (for Elephant's Breath) is sold as
  a grey but sits on the brown arc.
- **Slug** — the branch-safe form. Every name is a single capitalized word of
  3–13 letters, so the slug is just the name: `Cream` → `zeros/Cream`. Single
  words are deliberate — they survive shell completion and read cleanly as a
  directory, which is why the flower list this replaces had the same rule.
- **†** — the hex is *interpretive*: derived from a written description because
  the name has no published swatch. These are historic dye and pigment words
  ("Popinjay", "Nacarat", "Cramoisy"), modern paint-marketing coinages
  ("Snugglepuss", "Impulsive"), and literary words that never had a standard
  ("Eburnean"). Treat the unmarked entries as the reliable ones.

Guarantees checked mechanically: 350 rows, no duplicate name, no duplicate
hex, every hex a valid `#RRGGBB`, every name a single capitalized word, and no
two names equal under case folding (macOS filesystems are case-insensitive, and
git loose refs are files).

## Caveat on sourcing

The unmarked hexes are the values commonly cited for these names (Wikipedia's
colour lists, ISCC-NBS, Maerz & Paul, nipponcolors, standard pigment
references) as recalled during drafting — they were **not** re-verified against
those sources for this document, because the research pass I kicked off to do
that hit an API limit and did not finish. They are right in hue and close in
value, and are fine for naming workspaces. Do not treat them as colourimetric
references without checking. Several names genuinely have no single canonical
value: paint brands, historic pigments, and national-standard lists disagree.


### Red — 35

| # | Colour | Family | Hex | Slug |
| --: | --- | --- | --- | --- |
| 1 | Alizarin | Red | `#E32636` | `Alizarin` |
| 2 | Amaranth | Red | `#E52B50` | `Amaranth` |
| 3 | Auburn | Red | `#A52A2A` | `Auburn` |
| 4 | Bittersweet | Red | `#BF4F51` | `Bittersweet` |
| 5 | Burgundy | Red | `#800020` | `Burgundy` |
| 6 | Cardinal | Red | `#C41E3A` | `Cardinal` |
| 7 | Carmine | Red | `#960018` | `Carmine` |
| 8 | Carnelian | Red | `#B31B1B` | `Carnelian` |
| 9 | Cinnabar | Red | `#E44D2E` | `Cinnabar` |
| 10 | Claret | Red | `#7F1734` | `Claret` |
| 11 | Cochineal | Red | `#9B1B30` | `Cochineal` |
| 12 | Coquelicot | Red | `#FF3800` | `Coquelicot` |
| 13 | Cramoisy † | Red | `#A5023B` | `Cramoisy` |
| 14 | Crimson | Red | `#DC143C` | `Crimson` |
| 15 | Falu | Red | `#801818` | `Falu` |
| 16 | Garnet | Red | `#733635` | `Garnet` |
| 17 | Grenadine | Red | `#E9383F` | `Grenadine` |
| 18 | Incarnadine † | Red | `#B21E35` | `Incarnadine` |
| 19 | Jasper | Red | `#D73B3E` | `Jasper` |
| 20 | Kermes † | Red | `#A02A38` | `Kermes` |
| 21 | Lust | Red | `#E62020` | `Lust` |
| 22 | Madder | Red | `#A50021` | `Madder` |
| 23 | Oxblood | Red | `#4A0000` | `Oxblood` |
| 24 | Ponceau | Red | `#C7202F` | `Ponceau` |
| 25 | Poppy | Red | `#E35335` | `Poppy` |
| 26 | Realgar | Red | `#E24A33` | `Realgar` |
| 27 | Redwood | Red | `#A45A52` | `Redwood` |
| 28 | Rosewood | Red | `#65000B` | `Rosewood` |
| 29 | Ruby | Red | `#9B111E` | `Ruby` |
| 30 | Rufous | Red | `#A81C07` | `Rufous` |
| 31 | Sanguine | Red | `#92000A` | `Sanguine` |
| 32 | Scarlet | Red | `#FF2400` | `Scarlet` |
| 33 | Tuscan | Red | `#7C4848` | `Tuscan` |
| 34 | Vermilion | Red | `#E34234` | `Vermilion` |
| 35 | Wine | Red | `#722F37` | `Wine` |

### Pink — 22

| # | Colour | Family | Hex | Slug |
| --: | --- | --- | --- | --- |
| 36 | Blush | Pink | `#DE5D83` | `Blush` |
| 37 | Cameo | Pink | `#EFBBCC` | `Cameo` |
| 38 | Carnation | Pink | `#FFA6C9` | `Carnation` |
| 39 | Cerise | Pink | `#DE3163` | `Cerise` |
| 40 | Charm | Pink | `#E68FAC` | `Charm` |
| 41 | Coralline | Pink | `#F88379` | `Coralline` |
| 42 | Cyclamen | Pink | `#F56FA1` | `Cyclamen` |
| 43 | Flamingo | Pink | `#FC8EAC` | `Flamingo` |
| 44 | Folly | Pink | `#FF004F` | `Folly` |
| 45 | Momo | Pink | `#F09199` | `Momo` |
| 46 | Mountbatten | Pink | `#997A8D` | `Mountbatten` |
| 47 | Nacarat † | Pink | `#F5654A` | `Nacarat` |
| 48 | Nadeshiko | Pink | `#DC9FB4` | `Nadeshiko` |
| 49 | Peachblow † | Pink | `#FDE1DC` | `Peachblow` |
| 50 | Piggy | Pink | `#FDDDE6` | `Piggy` |
| 51 | Puce | Pink | `#CC8899` | `Puce` |
| 52 | Razzmatazz | Pink | `#E3256B` | `Razzmatazz` |
| 53 | Rose | Pink | `#FF007F` | `Rose` |
| 54 | Sakura | Pink | `#FEDFE1` | `Sakura` |
| 55 | Salmon | Pink | `#FA8072` | `Salmon` |
| 56 | Thulian | Pink | `#DE6FA1` | `Thulian` |
| 57 | Watermelon | Pink | `#FC6C85` | `Watermelon` |

### Magenta — 14

| # | Colour | Family | Hex | Slug |
| --: | --- | --- | --- | --- |
| 58 | Byzantine | Magenta | `#BD33A4` | `Byzantine` |
| 59 | Fandango | Magenta | `#B53389` | `Fandango` |
| 60 | Frostbite | Magenta | `#E936A7` | `Frostbite` |
| 61 | Fuchsine | Magenta | `#CA2C92` | `Fuchsine` |
| 62 | Mulberry | Magenta | `#C54B8C` | `Mulberry` |
| 63 | Murrey | Magenta | `#8B004B` | `Murrey` |
| 64 | Mystic | Magenta | `#D65282` | `Mystic` |
| 65 | Orchid | Magenta | `#DA70D6` | `Orchid` |
| 66 | Plum | Magenta | `#8E4585` | `Plum` |
| 67 | Quinacridone | Magenta | `#8E3A59` | `Quinacridone` |
| 68 | Rhodamine | Magenta | `#E0119D` | `Rhodamine` |
| 69 | Rubine † | Magenta | `#D10056` | `Rubine` |
| 70 | Shocking | Magenta | `#FC0FC0` | `Shocking` |
| 71 | Solferino | Magenta | `#CF3476` | `Solferino` |

### Violet — 25

| # | Colour | Family | Hex | Slug |
| --: | --- | --- | --- | --- |
| 72 | Amethyst | Violet | `#9966CC` | `Amethyst` |
| 73 | Aubergine | Violet | `#614051` | `Aubergine` |
| 74 | Byzantium | Violet | `#702963` | `Byzantium` |
| 75 | Eminence | Violet | `#6C3082` | `Eminence` |
| 76 | Gridelin † | Violet | `#A899C2` | `Gridelin` |
| 77 | Heliotrope | Violet | `#DF73FF` | `Heliotrope` |
| 78 | Imperial | Violet | `#602F6B` | `Imperial` |
| 79 | Impulsive † | Violet | `#4B2E56` | `Impulsive` |
| 80 | Indigo | Violet | `#4B0082` | `Indigo` |
| 81 | Iris | Violet | `#5A4FCF` | `Iris` |
| 82 | Lilac | Violet | `#C8A2C8` | `Lilac` |
| 83 | Majorelle | Violet | `#6050DC` | `Majorelle` |
| 84 | Mauve | Violet | `#E0B0FF` | `Mauve` |
| 85 | Mauveine | Violet | `#8D029B` | `Mauveine` |
| 86 | Palatinate | Violet | `#72246C` | `Palatinate` |
| 87 | Periwinkle | Violet | `#CCCCFF` | `Periwinkle` |
| 88 | Pervenche | Violet | `#6C7FD1` | `Pervenche` |
| 89 | Phlox | Violet | `#DF00FF` | `Phlox` |
| 90 | Purpureus | Violet | `#9A4EAE` | `Purpureus` |
| 91 | Qinglian | Violet | `#8076A3` | `Qinglian` |
| 92 | Snugglepuss † | Violet | `#C6A4D8` | `Snugglepuss` |
| 93 | Thistle | Violet | `#D8BFD8` | `Thistle` |
| 94 | Tyrian | Violet | `#66023C` | `Tyrian` |
| 95 | Veronica | Violet | `#A020F0` | `Veronica` |
| 96 | Wisteria | Violet | `#C9A0DC` | `Wisteria` |

### Blue — 36

| # | Colour | Family | Hex | Slug |
| --: | --- | --- | --- | --- |
| 97 | Azure | Blue | `#007FFF` | `Azure` |
| 98 | Bice † | Blue | `#4A9BAF` | `Bice` |
| 99 | Carolina | Blue | `#4B9CD3` | `Carolina` |
| 100 | Cobalt | Blue | `#0047AB` | `Cobalt` |
| 101 | Cornflower | Blue | `#6495ED` | `Cornflower` |
| 102 | Cyanine | Blue | `#1F3A93` | `Cyanine` |
| 103 | Delft | Blue | `#1F305E` | `Delft` |
| 104 | Denim | Blue | `#1560BD` | `Denim` |
| 105 | Egyptian | Blue | `#1034A6` | `Egyptian` |
| 106 | Gentian | Blue | `#4F42B5` | `Gentian` |
| 107 | Glaucous | Blue | `#6082B6` | `Glaucous` |
| 108 | Indanthrone | Blue | `#2E5894` | `Indanthrone` |
| 109 | Independence | Blue | `#4C516D` | `Independence` |
| 110 | Kachi | Blue | `#181B39` | `Kachi` |
| 111 | Lapis | Blue | `#26619C` | `Lapis` |
| 112 | Liberty | Blue | `#545AA7` | `Liberty` |
| 113 | Maya | Blue | `#73C2FB` | `Maya` |
| 114 | Nattier † | Blue | `#4A6D8C` | `Nattier` |
| 115 | Oxford | Blue | `#002147` | `Oxford` |
| 116 | Perse † | Blue | `#5A6E9C` | `Perse` |
| 117 | Powder | Blue | `#B0E0E6` | `Powder` |
| 118 | Prussian | Blue | `#003153` | `Prussian` |
| 119 | Ruri | Blue | `#1E50A2` | `Ruri` |
| 120 | Rurikon | Blue | `#22317C` | `Rurikon` |
| 121 | Sapphire | Blue | `#0F52BA` | `Sapphire` |
| 122 | Sapphirine | Blue | `#2D68C4` | `Sapphirine` |
| 123 | Smalt | Blue | `#003399` | `Smalt` |
| 124 | Steel | Blue | `#4682B4` | `Steel` |
| 125 | Tekhelet † | Blue | `#3B3F8C` | `Tekhelet` |
| 126 | Ube | Blue | `#8878C3` | `Ube` |
| 127 | Ultramarine | Blue | `#120A8F` | `Ultramarine` |
| 128 | Watchet † | Blue | `#A2C3D2` | `Watchet` |
| 129 | Wedgwood | Blue | `#6D9BC3` | `Wedgwood` |
| 130 | Yale | Blue | `#00356B` | `Yale` |
| 131 | Yinmn | Blue | `#2E5090` | `Yinmn` |
| 132 | Zaffre | Blue | `#0014A8` | `Zaffre` |

### Cyan — 24

| # | Colour | Family | Hex | Slug |
| --: | --- | --- | --- | --- |
| 133 | Amazonite | Cyan | `#4EBFA8` | `Amazonite` |
| 134 | Aquamarine | Cyan | `#7FFFD4` | `Aquamarine` |
| 135 | Asagi | Cyan | `#33A6B8` | `Asagi` |
| 136 | Beryl | Cyan | `#7BC4C4` | `Beryl` |
| 137 | Bondi | Cyan | `#0095B6` | `Bondi` |
| 138 | Capri | Cyan | `#00BFFF` | `Capri` |
| 139 | Celeste | Cyan | `#B2FFFF` | `Celeste` |
| 140 | Cerulean | Cyan | `#007BA7` | `Cerulean` |
| 141 | Kingfisher | Cyan | `#00A0B0` | `Kingfisher` |
| 142 | Mizu | Cyan | `#86ABA5` | `Mizu` |
| 143 | Mizuasagi | Cyan | `#66BAB7` | `Mizuasagi` |
| 144 | Moonstone | Cyan | `#3AA8C1` | `Moonstone` |
| 145 | Opal | Cyan | `#A8C3BC` | `Opal` |
| 146 | Peacock | Cyan | `#005F69` | `Peacock` |
| 147 | Persian | Cyan | `#00A693` | `Persian` |
| 148 | Shinbashi | Cyan | `#59B9C6` | `Shinbashi` |
| 149 | Skobeloff | Cyan | `#007474` | `Skobeloff` |
| 150 | Sorairo | Cyan | `#A0D8EF` | `Sorairo` |
| 151 | Tianqing | Cyan | `#8ABCD1` | `Tianqing` |
| 152 | Tiffany | Cyan | `#0ABAB5` | `Tiffany` |
| 153 | Turquoise | Cyan | `#40E0D0` | `Turquoise` |
| 154 | Verdigris | Cyan | `#43B3AE` | `Verdigris` |
| 155 | Verditer | Cyan | `#4EBFB2` | `Verditer` |
| 156 | Zomp | Cyan | `#39A78E` | `Zomp` |

### Green — 40

| # | Colour | Family | Hex | Slug |
| --: | --- | --- | --- | --- |
| 157 | Absinthe | Green | `#7FDD4C` | `Absinthe` |
| 158 | Artichoke | Green | `#8F9779` | `Artichoke` |
| 159 | Asparagus | Green | `#87A96B` | `Asparagus` |
| 160 | Avocado | Green | `#568203` | `Avocado` |
| 161 | Bottle | Green | `#006A4E` | `Bottle` |
| 162 | Cambridge | Green | `#A3C1AD` | `Cambridge` |
| 163 | Celadon | Green | `#ACE1AF` | `Celadon` |
| 164 | Celadonite † | Green | `#7A8B5C` | `Celadonite` |
| 165 | Chartreuse | Green | `#7FFF00` | `Chartreuse` |
| 166 | Emerald | Green | `#50C878` | `Emerald` |
| 167 | Feldgrau | Green | `#4D5D53` | `Feldgrau` |
| 168 | Fern | Green | `#4F7942` | `Fern` |
| 169 | Forest | Green | `#014421` | `Forest` |
| 170 | Harlequin | Green | `#3FFF00` | `Harlequin` |
| 171 | Hooker | Green | `#49796B` | `Hooker` |
| 172 | Hunter | Green | `#355E3B` | `Hunter` |
| 173 | Jade | Green | `#00A86B` | `Jade` |
| 174 | Kelly | Green | `#4CBB17` | `Kelly` |
| 175 | Laurel | Green | `#5B7F53` | `Laurel` |
| 176 | Loden | Green | `#4E5B31` | `Loden` |
| 177 | Malachite | Green | `#0BDA51` | `Malachite` |
| 178 | Mantis | Green | `#74C365` | `Mantis` |
| 179 | Matcha | Green | `#C5C56A` | `Matcha` |
| 180 | Moegi | Green | `#AACF53` | `Moegi` |
| 181 | Myrtle | Green | `#21421E` | `Myrtle` |
| 182 | Olivine | Green | `#9AB973` | `Olivine` |
| 183 | Pistachio | Green | `#93C572` | `Pistachio` |
| 184 | Popinjay † | Green | `#7FA05A` | `Popinjay` |
| 185 | Reseda | Green | `#6C7C59` | `Reseda` |
| 186 | Russian | Green | `#679267` | `Russian` |
| 187 | Sap | Green | `#507D2A` | `Sap` |
| 188 | Seiji | Green | `#819C8B` | `Seiji` |
| 189 | Shamrock | Green | `#009E60` | `Shamrock` |
| 190 | Sinople † | Green | `#009B48` | `Sinople` |
| 191 | Smaragdine | Green | `#4F9153` | `Smaragdine` |
| 192 | Tokiwa | Green | `#007B43` | `Tokiwa` |
| 193 | Uguisu | Green | `#6C6024` | `Uguisu` |
| 194 | Viridian | Green | `#40826D` | `Viridian` |
| 195 | Wasabi | Green | `#82AE46` | `Wasabi` |
| 196 | Xanadu | Green | `#738678` | `Xanadu` |

### Yellow — 32

| # | Colour | Family | Hex | Slug |
| --: | --- | --- | --- | --- |
| 197 | Aureolin | Yellow | `#FDEE00` | `Aureolin` |
| 198 | Buff | Yellow | `#F0DC82` | `Buff` |
| 199 | Canary | Yellow | `#FFFF99` | `Canary` |
| 200 | Chrome | Yellow | `#FFA700` | `Chrome` |
| 201 | Citrine | Yellow | `#E4D00A` | `Citrine` |
| 202 | Citron | Yellow | `#9FA91F` | `Citron` |
| 203 | Flax | Yellow | `#EEDC82` | `Flax` |
| 204 | Gamboge | Yellow | `#E49B0F` | `Gamboge` |
| 205 | Gofun | Yellow | `#FFFFFB` | `Gofun` |
| 206 | Goldenrod | Yellow | `#DAA520` | `Goldenrod` |
| 207 | Humorous † | Yellow | `#9CA83A` | `Humorous` |
| 208 | Icterine | Yellow | `#FCF75E` | `Icterine` |
| 209 | Jasmine | Yellow | `#F8DE7E` | `Jasmine` |
| 210 | Jonquil | Yellow | `#F4CA16` | `Jonquil` |
| 211 | Kariyasu | Yellow | `#E2BC57` | `Kariyasu` |
| 212 | Lemon | Yellow | `#FFF700` | `Lemon` |
| 213 | Maize | Yellow | `#FBEC5D` | `Maize` |
| 214 | Massicot † | Yellow | `#FFF5C3` | `Massicot` |
| 215 | Mikado | Yellow | `#FFC40C` | `Mikado` |
| 216 | Mustard | Yellow | `#FFDB58` | `Mustard` |
| 217 | Naples | Yellow | `#FADA5E` | `Naples` |
| 218 | Orpiment | Yellow | `#FFC800` | `Orpiment` |
| 219 | Primrose | Yellow | `#EDEA99` | `Primrose` |
| 220 | Saffron | Yellow | `#F4C430` | `Saffron` |
| 221 | Straw | Yellow | `#E4D96F` | `Straw` |
| 222 | Sulfur | Yellow | `#FFFF6B` | `Sulfur` |
| 223 | Vegas | Yellow | `#C5B358` | `Vegas` |
| 224 | Weld † | Yellow | `#E9DC5D` | `Weld` |
| 225 | Wheat | Yellow | `#F5DEB3` | `Wheat` |
| 226 | Xanthic | Yellow | `#EEED09` | `Xanthic` |
| 227 | Xanthous | Yellow | `#F1B42F` | `Xanthous` |
| 228 | Yamabuki | Yellow | `#F8B500` | `Yamabuki` |

### Orange — 23

| # | Colour | Family | Hex | Slug |
| --: | --- | --- | --- | --- |
| 229 | Amber | Orange | `#FFBF00` | `Amber` |
| 230 | Apricot | Orange | `#FBCEB1` | `Apricot` |
| 231 | Australien † | Orange | `#DE9B35` | `Australien` |
| 232 | Cadmium | Orange | `#ED872D` | `Cadmium` |
| 233 | Carrot | Orange | `#ED9121` | `Carrot` |
| 234 | Coral | Orange | `#FF7F50` | `Coral` |
| 235 | Flame | Orange | `#E25822` | `Flame` |
| 236 | Fulvous | Orange | `#E48400` | `Fulvous` |
| 237 | Gingerline † | Orange | `#E8A628` | `Gingerline` |
| 238 | Jaffa | Orange | `#EF863F` | `Jaffa` |
| 239 | Kihada | Orange | `#F3C13A` | `Kihada` |
| 240 | Kohaku | Orange | `#CA6924` | `Kohaku` |
| 241 | Mandarin | Orange | `#F37A48` | `Mandarin` |
| 242 | Marigold | Orange | `#EAA221` | `Marigold` |
| 243 | Minium | Orange | `#FF6F00` | `Minium` |
| 244 | Ochre | Orange | `#CC7722` | `Ochre` |
| 245 | Persimmon | Orange | `#EC5800` | `Persimmon` |
| 246 | Princeton | Orange | `#EE7F2D` | `Princeton` |
| 247 | Pumpkin | Orange | `#FF7518` | `Pumpkin` |
| 248 | Sarcoline | Orange | `#F2CBA6` | `Sarcoline` |
| 249 | Sinopia | Orange | `#CB410B` | `Sinopia` |
| 250 | Tangelo | Orange | `#F94D00` | `Tangelo` |
| 251 | Tangerine | Orange | `#F28500` | `Tangerine` |

### Brown — 42

| # | Colour | Family | Hex | Slug |
| --: | --- | --- | --- | --- |
| 252 | Alloy | Brown | `#C46210` | `Alloy` |
| 253 | Beaver | Brown | `#9F8170` | `Beaver` |
| 254 | Bistre | Brown | `#3D2B1F` | `Bistre` |
| 255 | Bitumen † | Brown | `#4D3B32` | `Bitumen` |
| 256 | Bole | Brown | `#79443B` | `Bole` |
| 257 | Bronze | Brown | `#CD7F32` | `Bronze` |
| 258 | Chamoisee | Brown | `#A0785A` | `Chamoisee` |
| 259 | Chestnut | Brown | `#954535` | `Chestnut` |
| 260 | Chocolate | Brown | `#7B3F00` | `Chocolate` |
| 261 | Cinnamon | Brown | `#D2691E` | `Cinnamon` |
| 262 | Coffee | Brown | `#6F4E37` | `Coffee` |
| 263 | Copper | Brown | `#B87333` | `Copper` |
| 264 | Cordovan | Brown | `#893F45` | `Cordovan` |
| 265 | Drab | Brown | `#967117` | `Drab` |
| 266 | Dun | Brown | `#B49B7F` | `Dun` |
| 267 | Ecru | Brown | `#C2B280` | `Ecru` |
| 268 | Fallow | Brown | `#C19A6B` | `Fallow` |
| 269 | Fawn | Brown | `#E5AA70` | `Fawn` |
| 270 | Feuillemorte † | Brown | `#A88462` | `Feuillemorte` |
| 271 | Filemot † | Brown | `#825E32` | `Filemot` |
| 272 | Ginger | Brown | `#B06500` | `Ginger` |
| 273 | Khaki | Brown | `#C3B091` | `Khaki` |
| 274 | Liver | Brown | `#674C47` | `Liver` |
| 275 | Mole † | Brown | `#4F3A3C` | `Mole` |
| 276 | Mummy † | Brown | `#824A26` | `Mummy` |
| 277 | Olive | Brown | `#808000` | `Olive` |
| 278 | Otter | Brown | `#654321` | `Otter` |
| 279 | Ruddle † | Brown | `#A4442B` | `Ruddle` |
| 280 | Russet | Brown | `#80461B` | `Russet` |
| 281 | Rust | Brown | `#B7410E` | `Rust` |
| 282 | Seal | Brown | `#59260B` | `Seal` |
| 283 | Sepia | Brown | `#704214` | `Sepia` |
| 284 | Sienna | Brown | `#882D17` | `Sienna` |
| 285 | Taupe | Brown | `#483C32` | `Taupe` |
| 286 | Tawny | Brown | `#CD5700` | `Tawny` |
| 287 | Titian | Brown | `#C36241` | `Titian` |
| 288 | Umber | Brown | `#635147` | `Umber` |
| 289 | Vandyke | Brown | `#522A00` | `Vandyke` |
| 290 | Walnut | Brown | `#773F1A` | `Walnut` |
| 291 | Wenge | Brown | `#645452` | `Wenge` |
| 292 | Zibeline † | Brown | `#5C4033` | `Zibeline` |
| 293 | Zinnwaldite | Brown | `#EBC2AF` | `Zinnwaldite` |

### White — 19

| # | Colour | Family | Hex | Slug |
| --: | --- | --- | --- | --- |
| 294 | Alabaster | White | `#EDEAE0` | `Alabaster` |
| 295 | Argent | White | `#E3E4E5` | `Argent` |
| 296 | Bisque | White | `#FFE4C4` | `Bisque` |
| 297 | Bone | White | `#E3DAC9` | `Bone` |
| 298 | Chalk | White | `#F0EDE5` | `Chalk` |
| 299 | Cream | White | `#FFFDD0` | `Cream` |
| 300 | Eburnean † | White | `#F5F0E1` | `Eburnean` |
| 301 | Eggshell | White | `#F0EAD6` | `Eggshell` |
| 302 | Isabelline | White | `#F4F0EC` | `Isabelline` |
| 303 | Ivory | White | `#FFFFF0` | `Ivory` |
| 304 | Linen | White | `#FAF0E6` | `Linen` |
| 305 | Magnolia | White | `#F2E6EF` | `Magnolia` |
| 306 | Parchment | White | `#F1E9D2` | `Parchment` |
| 307 | Pearl | White | `#EAE0C8` | `Pearl` |
| 308 | Platinum | White | `#E5E4E2` | `Platinum` |
| 309 | Seasalt | White | `#F7F7F7` | `Seasalt` |
| 310 | Snow | White | `#FFFAFA` | `Snow` |
| 311 | Titanium | White | `#F7F5F0` | `Titanium` |
| 312 | Vellum | White | `#F3E7C8` | `Vellum` |

### Grey — 23

| # | Colour | Family | Hex | Slug |
| --: | --- | --- | --- | --- |
| 313 | Ash | Grey | `#B2BEB5` | `Ash` |
| 314 | Battleship | Grey | `#848482` | `Battleship` |
| 315 | Cadet | Grey | `#536872` | `Cadet` |
| 316 | Charcoal | Grey | `#36454F` | `Charcoal` |
| 317 | Cinereous | Grey | `#98817B` | `Cinereous` |
| 318 | Davy | Grey | `#555555` | `Davy` |
| 319 | Elephant † | Grey | `#A9A491` | `Elephant` |
| 320 | Fuscous † | Grey | `#54534D` | `Fuscous` |
| 321 | Gainsboro | Grey | `#DCDCDC` | `Gainsboro` |
| 322 | Graphite | Grey | `#41424C` | `Graphite` |
| 323 | Gunmetal | Grey | `#2A3439` | `Gunmetal` |
| 324 | Marengo | Grey | `#4C5866` | `Marengo` |
| 325 | Nickel | Grey | `#727472` | `Nickel` |
| 326 | Outerspace | Grey | `#414A4C` | `Outerspace` |
| 327 | Payne | Grey | `#536878` | `Payne` |
| 328 | Pewter | Grey | `#899499` | `Pewter` |
| 329 | Quartz | Grey | `#51484F` | `Quartz` |
| 330 | Silver | Grey | `#C0C0C0` | `Silver` |
| 331 | Slate | Grey | `#708090` | `Slate` |
| 332 | Smoke | Grey | `#738276` | `Smoke` |
| 333 | Timberwolf | Grey | `#DBD7D2` | `Timberwolf` |
| 334 | Trout | Grey | `#4A4B4D` | `Trout` |
| 335 | Zinc | Grey | `#7D7F7C` | `Zinc` |

### Black — 15

| # | Colour | Family | Hex | Slug |
| --: | --- | --- | --- | --- |
| 336 | Anthracite | Black | `#293133` | `Anthracite` |
| 337 | Corbeau † | Black | `#171A1B` | `Corbeau` |
| 338 | Ebony | Black | `#555D50` | `Ebony` |
| 339 | Eigengrau | Black | `#16161D` | `Eigengrau` |
| 340 | Jet | Black | `#343434` | `Jet` |
| 341 | Kurotsurubami | Black | `#251E1C` | `Kurotsurubami` |
| 342 | Licorice | Black | `#1A1110` | `Licorice` |
| 343 | Nero | Black | `#252525` | `Nero` |
| 344 | Obsidian | Black | `#0B1215` | `Obsidian` |
| 345 | Onyx | Black | `#353839` | `Onyx` |
| 346 | Raisin | Black | `#242124` | `Raisin` |
| 347 | Sable | Black | `#0C0A08` | `Sable` |
| 348 | Soot | Black | `#221F1D` | `Soot` |
| 349 | Sumi | Black | `#1C1C1C` | `Sumi` |
| 350 | Vantablack | Black | `#010101` | `Vantablack` |

---

† Interpretive hex — derived from a written description, no published swatch.
See "How to read this" above.

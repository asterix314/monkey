#import "@preview/easy-pinyin:0.1.0": pinyin, zhuyin
#import "@preview/colorful-boxes:1.4.3": stickybox

#let 注音 = zhuyin.with(
  delimiter: "|", 
  spacing: 1%, 
  scale: 0.8
)

#let 四声列表 = table.with(
  columns: (1fr,1fr,1fr,1fr,1fr,1fr,1fr,1fr,1fr,1fr,1fr,1fr),
  align: center,
  stroke: (x, y) => (
    y: 0.5pt,
    left: if x in (0, 4, 8, 12) {0.5pt}, 
    right: if x == 11 {0.5pt}
  )
)

#let 普通列表 = table.with(
  columns: (1fr,1fr,1fr,1fr,1fr,1fr,1fr,1fr),
  align: center,
  stroke: (x, y) => (
    y: 0.5pt,
    left: if x == 0 {0.5pt}, 
    right: if x == 7 {0.5pt}
  )
)

#let hl(content) = highlight(
  fill: black,
  extent: 3pt,
  radius: 3pt,
  text(
    font: "LXGW ZhenKai GB",
    size: 14pt,
    fill: white,
    content
  )
)+text(fill: black, baseline:-0.4pt)[▶︎]

#set text(
  font: ("LXGW WenKai"),
  size: 13pt)

#set page(
  paper: "a4",
  flipped: true,
  columns: 2,
  margin: (
    top: 4em,
    bottom: 3em, x: 2em),
  header: {
    set text(font: "YouYuan")
    box(
      image("xhs.svg", width: 100%), 
      fill: red, 
      height: 20pt,
      width: 46pt,
      inset: 2pt,
      baseline: 5pt,
      radius: 6pt,
    ) + [ | 奇宝爹]
    h(1fr)
    [拼读表压缩版]
  },
  // background: rotate(
  //   24deg, 
  //   text(
  //     size: 140pt,
  //     weight: "bold",
  //     fill: red.lighten(70%), 
  //     font: "Microsoft YaHei")[*SAMPLE\ 样例*]
  // )
)

#show heading.where(level: 2): set align(center)


== #注音[单|韵|母|：a、o、e、i、u、ü][da1n|yu4n|mu3|]

#四声列表(
  [ā], [á], [ǎ], [à],
  [ō], [ó], [ǒ], [ò],
  [ē], [é], [ě], [è],
  [ī], [í], [ǐ], [ì],
  [ū], [ú], [ǔ], [ù],
  [ǖ], [ǘ], [ǚ], [ǜ]
)

== #注音[拼|读|表|一|：b、p、m、f][pi1n|du2|bia3o|yi1|]

#四声列表(
  [bā], [bá], [bǎ], [bà],
  [bō], [bó], [bǒ], [bò],
  [bī], [bí], [bǐ], [bì], 
  [bū], [bú], [bǔ], [bù],
  [pā], [pá], [],   [pà],
  [pō], [pó], [pǒ], [pò], 
  [pī], [pí], [pǐ], [pì],
  [pū], [pú], [pǔ], [pù],
  [mā], [má], [mǎ], [mà], 
  [mō], [mó], [mǒ], [mò],
  [mī], [mí], [mǐ], [mì],
  [],   [mú], [mǔ], [mù], 
  [fā], [fá], [fǎ], [fà],
  [],   [fó], [],   [],
  [fū], [fú], [fǔ], [fù]
)



== #注音[拼|读|表|二|：d、t、n、l][pi1n|du2|bia3o|e4r|]

#四声列表(
  columns: (1fr,1fr,1fr,auto,1fr,1fr,1fr,1fr,1fr,1fr,1fr,auto),
  [dā], [dá], [dǎ], [dà],
  [dē], [dé], [],   [de],
  [dī], [dí], [dǐ], [dì],
  [dū], [dú], [dǔ], [dù],
  [tā], [],   [tǎ], [tà],
  [],   [],   [],   [tè/e],
  [tī], [tí], [tǐ], [tì], 
  [tū], [tú], [tǔ], [tù],
  [nā], [ná], [nǎ], [nà],   
  [],   [né], [],   [nè/e],
  [nī], [ní], [nǐ], [nì],
  [],   [nú], [nǔ], [nù],
  [],   [],   [nǚ], [nǜ],
  [lā], [lá], [lǎ], [là],
  [lē], [],   [],   [lè/e],
  [lī], [lí], [lǐ], [lì],
  [lū], [lú], [lǔ], [lù],
  [],   [lǘ], [lǚ], [lǜ]
)

== #注音[拼|读|表|三|：g、k、h][pi1n|du2|bia3o|sa1n|]

#四声列表(
  columns: (1fr,1fr,1fr,1fr,1fr,1fr,1fr,auto,1fr,1fr,1fr,auto),
  [ɡā], [ɡá], [ɡǎ], [ɡà],
  [ɡē], [ɡé], [ɡě], [ɡè/e],
  [ɡū], [ɡǔ], [],   [ɡù],
  [kā], [],   [kǎ], [],
  [kē], [ké], [kě], [kè],
  [kū], [],   [kǔ], [kù],
  [hā], [há], [hǎ], [hà],
  [hē], [hé], [],   [hè/e],
  [hū], [hú], [hǔ], [hù]
)

== #注音[拼|读|表|四|：j、q、x][pi1n|du2|bia3o|si4|]

#四声列表(
  [jī], [jí], [jǐ], [jì],
  [jū], [jú], [jǔ], [jù],
  [qī], [qí], [qǐ], [qì],
  [qū], [qú], [qǔ], [qù],
  [xī], [xí], [xǐ], [xì],
  [xū], [xú], [xǔ], [xù]
)

#align(center,
  stickybox(
    rotation: -3deg,
    width: 10cm,
    tape: false,
    注音[小|ü|有|礼|貌|，|见|到|j、q、x|就|脱|帽|。][xia3o||yo3u|li3|ma4o||jia4n|da4o||jiu4|tuo1|ma4o|]
  )
)

== #注音[拼|读|表|五|：z、c、s][pi1n|du2|bia3o|wu3|]

#四声列表(
  [zā], [zá], [zǎ], [],
  [],   [zé], [],   [zè],
  [zū], [zú], [zǔ], [],
  [cā], [],   [cǎ], [],
  [],   [],   [],   [cè],
  [cū], [cú], [],   [cù],
  [sā], [],   [sǎ], [sà],
  [],   [],   [],   [sè],
  [sū], [sú], [],   [sù]
)


== #注音[拼|读|表|六|：zh、ch、sh、r、y、w][pi1n|du2|bia3o|liu4|]

#四声列表(
  columns: (1fr,1fr,1fr,1fr,1fr,1fr,1fr,1fr,1fr,1fr,1fr,auto),
  [zhā], [zhá], [zhǎ], [zhà],
  [zhū], [zhú], [zhǔ], [zhù],
  [zhē], [zhé], [zhě], [zhè/e],
  [chā], [chá], [chǎ], [chà],
  [chē], [],    [chě], [chè],
  [chū], [chú], [chǔ], [chù],
  [shā], [shá], [shǎ], [shà],
  [shē], [shé], [shě], [shè],
  [shū], [shú], [shǔ], [shù],
  [],    [],    [rě],  [rè],
  [],    [rú],  [rǔ],  [rù],
  [yā],  [yá],  [yǎ],  [yà],
  [wā],  [wá],  [wǎ],  [wà],
  [wō],  [],    [wǒ],  [wò],
)


== #注音[复|韵|母|拼|读|表][fu4|yu4n|mu3|pi1n|du2|bia3o]

#普通列表(
  hl[ai], [bāi], [pái], [mài], [dāi],   [tái],  [nǎi],  [lái], [ɡǎi], [kāi], [hǎi], [zǎi], [cài], [sài], [zhāi],  [chái], [shài], [wǎi],
  hl[ei], [bēi], [péi], [měi], [fēi], [děi], [tēi], [něi],   [lèi],  [ɡěi],  [kēi], [hēi], [zéi], [cèi], [zhèi], [shéi], [wěi],
  hl[ui], [duì], [tuī], [ɡuǐ], [kuí], [huī], [zuǐ], [cuī], [suí], [zhuī], [chuī], [shuǐ], [ruǐ], 
  hl[ao], [bāo], [páo], [mào], [dāo], [táo], [nǎo], [lào], [ɡǎo], [kào], [háo], [zǎo], [cáo], [sào], [zhāo], [cháo], [shào], [ráo], [yào],
  hl[ou], [pōu], [móu], [fǒu], [dōu], [tóu], [nòu], [lóu], [ɡōu], [kòu], [hǒu], [zǒu], [còu], [sōu], [zhòu], [chǒu], [shǒu], [róu], [yòu], 
  hl[iu], [miù], [diū], [niú], [liú], [jiǔ], [qiū], [xiù],
  hl[ie], [bié], [piě], [miè], [diē], [tiě], [liè], [niē], [jiě], [qié], [xié], 
  hl[üe], [jué], [lüè], [quē], [nüè], [xuě],
  hl[er], [ér], [ěr], [èr],
  hl[an], [bǎn], [pàn], [mán], [fān], [dàn], [tǎn], [nán], [làn], [ɡān], [kàn], [hǎn], [zàn], [sǎn], [cān], [zhàn], [chán], [rán], [shǎn], [yān], [wàn], 
  hl[en], [bèn], [pén], [mèn], [fěn], [dèn], [nèn], [ɡēn], [kěn], [hěn], [zěn], [cēn], [sēn], [zhēn], [chén], [shěn], [rěn], [wèn], 
  hl[in], [bīn], [pīn], [mǐn], [nín], [lín], [jǐn], [qǐn], [xìn], 
  hl[un], [dùn], [tūn], [lún], [ɡǔn], [hún], [kùn], [zūn], [cún], [sūn], [rùn], [zhǔn], [chūn], [shùn], [jūn], [qún], [xūn], 
  hl[ang], [bānɡ], [pánɡ], [mǎnɡ], [fànɡ], [dānɡ], [tánɡ], [nánɡ], [lǎnɡ], [ɡànɡ], [kānɡ], [hánɡ], [zānɡ], [cánɡ], [sànɡ], [zhǎnɡ], [chánɡ], [shànɡ], [rǎnɡ], [yānɡ], [wánɡ],
  hl[eng], [bēnɡ], [pēnɡ], [mènɡ], [fěnɡ], [dēnɡ], [ténɡ], [nénɡ], [lěnɡ], [ɡènɡ], [hénɡ], [kēnɡ], [zēnɡ], [sēnɡ], [cénɡ], [zhēnɡ], [chènɡ], [shènɡ], [rēnɡ], [wēnɡ],
  hl[ing], [bǐnɡ], [pīnɡ], [mínɡ], [dīnɡ], [tínɡ], [nínɡ], [línɡ], [jìnɡ], [qǐnɡ], [xìnɡ],
  hl[ong], [dǒnɡ], [tónɡ], [nònɡ], [lónɡ], [ɡònɡ], [kònɡ], [hónɡ], [zōnɡ], [cónɡ], [sōnɡ], [zhǒnɡ], [chōnɡ], [rónɡ], [yǒnɡ]
)

== #注音[整|体|认|读|音|节][zhe3ng|ti3|re4n|du2|yi1n|jie2]

#普通列表(
  [zi],   [ci], [si], [zhi], [chi], [shi], [ri], [yi], [yu], [wu], 
  [ye], [yue], [yuan], [yin], [yun], [ying]
)

== #注音[三|拼|音|节|：i、u、ü|做|介|母][sa1n|pi1n|yi1n|jie2||zuo4|jie4|mu3]

- i做介母

#普通列表(
  hl[ia], [diǎ], [liǎ], [jiā], [qiā], [xiā],
  hl[iao], [biǎo], [piào], [jiāo], [qiáo], [miáo], 
  hl[ian], [pián], [diān], [tián], [miàn], [niǎn], [lián], [jiān], [qián], [xiān],
  hl[iang], [jiānɡ], [qiǎnɡ], [xiànɡ], [liánɡ], [niànɡ], 
  hl[iong], [jiǒnɡ], [xiónɡ]
)

- u做介母

#普通列表(
hl[uo], [duō], [tuō], [nuó], [luò], [kuò], [ɡuǒ], [huǒ], [zuò], [cuō], [suǒ], [zhuō], [chuō], [shuō], [ruò],
hl[ua], [ɡuā], [kuǎ], [huá], [zhuā],  [shuǎ],
hl[uai], [ɡuāi], [kuài], [huài], [chuài], [shuāi], 
hl[uan], [ɡuān], [kuǎn], [huàn], [zuàn], [cuān], [suān], [zhuǎn], [chuán], [shuàn], [ruǎn], 
hl[uang], [shuǎnɡ], [zhuānɡ]
)

- ü做介母

#普通列表(
  hl[uan], [quǎn], [xuàn],[juàn]
)

#set page(
  "a4",
  margin: (
    top: 2cm,
    bottom: 2em, 
    x: 2em,),
  flipped: true,
  header: {
    set text(font: "YouYuan", size: 14pt)
    (
      box(
        image("xhs.svg", width: 100%),
        fill: red,
        height: 20pt,
        width: 46pt,
        inset: 2pt,
        baseline: 5pt,
        radius: 6pt,
      )
        + [ | 奇宝爹]
    )
    h(1fr)
    [学前古诗词背诵]
  },
)

#let data = toml("古诗词.toml")

#let i = 1
// 创建表格
#columns(2, gutter: 1em)[
  #table(
    columns: (1em, 1fr),
    stroke: (x: none, y: 0.5pt),
    align: (
      right + top, 
      left + horizon),
    ..for (标题, 朝代, 作者, 内容) in data.古诗 {
      (
        [#i.],
        text(
          font: "Microsoft YaHei",
          size: 10pt,
          标题) + h(5pt) +
        text(
          font: "Microsoft YaHei",
          weight: "light",
          size: 9pt,
          box([[#朝代] #作者 /])
        ) +
        text(
          font: "LXGW WenKai",
          size: 9pt,
          内容
        )
      )
    i = i + 1
    }
  )
]
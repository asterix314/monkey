#set page(
  "a4",
  margin: (
    top: 5em,
    bottom: 2em, left: 4em, right: 4em,),
  flipped: true,
  columns: 2
)

#let data = toml("古诗词.toml")

#let i = 1
// 创建表格
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
        size: 11pt,
        标题) + h(5pt) +
      text(
        font: "Microsoft YaHei",
        weight: "light",
        size: 10pt,
        box([[#朝代] #作者 /])
      ) +
      text(
        font: "LXGW WenKai",
        size: 10pt,
        h(5pt) + 内容
      )
    )
  i = i + 1
  }
)
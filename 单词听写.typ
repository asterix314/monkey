
#set page(
  paper: "a4",
  margin: (x: 2cm, top: 3cm),
  header: {
    set text(font: "YouYuan", size: 14pt)
    (
      box(
        image("emson.png", width: 100%),
        height:40pt,
        width: 100pt,
        baseline: 12pt,
      )
        + [ | CVC练习]
    )
    h(1fr)
    [日期：#underline[2026 - ~~~~~~]]
  },
  footer: context {
    set text(font: "Segoe Script", size: 14pt)
    align(center)[-- #counter(page).display() --]
  },
)

#set text(24pt, font: ("Playwrite NZ Basic", "YouYuan"), weight: "light")
//#set par(leading: 4em, spacing: 4em)

#let guides = block(breakable: false,
  table(
    columns: (1fr),
    inset: 0pt,
    
    stroke: (_, y) => if y == 0 {
      (top: (paint: gray, thickness: 0.8pt))
    } else if y == 1 {
      (y: (paint: gray, thickness: 0.6pt, dash:"dashed"))
    } else {
      (bottom: (paint: gray, thickness: 0.8pt))
    },
    v(.38em),v(.42em),v(.38em)
  )
)

#let guided = text.with(24pt, font: "Playwrite NZ Basic Guides")

#show heading: set align(center)
#show heading: set text(size: 20pt)
#show heading: set block(below: 2em)

= 抄写

#guided[jam] #h(1fr) jam #h(1fr) jam #h(1fr) #guided[dad] #h(1fr) dad #h(1fr) dad

#guides

#guided[mad] #h(1fr) mad #h(1fr) mad #h(1fr) #guided[sad] #h(1fr) sad #h(1fr) sad 

#guides

= 听写

#guides

#guides

#guides

#guides

#guides

#guides

= 抄写

#guided[cat] #h(1fr) cat #h(1fr) cat #h(1fr) #guided[fat] #h(1fr) fat #h(1fr) fat

#guides

#guided[man] #h(1fr) man #h(1fr) #guided[cap] #h(1fr) cap #h(1fr) #guided[bag] #h(1fr) bag

#guides

= 听写

#guides

#guides

#guides

#guides

#guides

#guides

#guides

#guides

#guides

#guides

#guides

#guides

#guides

#guides

#guides

#guides

#guides

#guides

#guides

#guides

#guides

#guides

#guides

#guides

#guides

#guides

#guides

#guides

#guides

#guides
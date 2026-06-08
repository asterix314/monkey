
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
        + [ | 英文书写练习]
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


#guided[hen] #h(1fr) hen #h(1fr) #guided[ten] #h(1fr) ten #h(1fr) #guided[bed] #h(1fr) bed

#guides

#guided[red] #h(1fr) red #h(1fr) #guided[leg] #h(1fr) leg #h(1fr) #guided[get] #h(1fr) get

#guides

#guides

#guides

#guided[jam] #h(1fr) jam #h(1fr) #guided[dad] #h(1fr) dad #h(1fr) #guided[mad] #h(1fr) mad

#guides

#guided[sad] #h(1fr) sad #h(1fr) #guided[cat] #h(1fr) cat #h(1fr) #guided[fat] #h(1fr) fat

#guides

#guides

#guides

#guides

#guided[man] #h(1fr) man #h(1fr) #guided[cap] #h(1fr) cap #h(1fr) #guided[bag] #h(1fr) bag

#guides

#guided[van] #h(1fr) van #h(1fr) #guided[lap] #h(1fr) lap #h(1fr) #guided[nap] #h(1fr) nap

#guides

#guides

#guides

#guides

#guided[tab] #h(1fr) tab #h(1fr) #guided[cab] #h(1fr) cab #h(1fr) #guided[kid] #h(1fr) kid

#guides

#guided[ran] #h(1fr) ran #h(1fr) #guided[lab] #h(1fr) lab #h(1fr) #guided[mag] #h(1fr) mag

#guides

#guides

#guides

#guided[beg] #h(1fr) beg #h(1fr) #guided[egg] #h(1fr) egg #h(1fr) #guided[jet] #h(1fr) jet

#guides

#guided[wet] #h(1fr) wet #h(1fr) #guided[less] #h(1fr) less #h(1fr) #guided[mess] #h(1fr) mess

#guides

#guides

#guides

#guides

#guides

#guides

#guides

The #h(1fr) egg #h(1fr) has #h(1fr) ten #h(1fr) legs.

#guides

#guides

#guides

#guides

The #h(1fr) man #h(1fr) ran #h(1fr) to #h(1fr) the #h(1fr) van.

#guides

#guides

#guides

#guides

#guides

#guides

#guides

#guides
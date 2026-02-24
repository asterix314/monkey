
#set page(
  paper: "a4",
  margin: (x: 3em),
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
    [英文抄写练习]
  },
  footer: context {
    set text(font: "Segoe Script", size: 14pt)
    align(center)[-- #counter(page).display() --]
  },
)

#let scribe(sentences, words) = {
  block(breakable: false,
    table(
      columns: (1fr),
      inset: 2pt,
      stroke: (_, y) => if y == 1 or y == 4 {
        (bottom: (paint: gray, thickness: 0.6pt))
      } else if y > 0 {
        (bottom: (paint: gray, thickness: 0.6pt, dash: "dotted"))
      },
      text(24pt, font: "Playwrite NZ Basic Guides", sentences)
      + h(1em) + text(24pt, font: "Playwrite NZ Basic", weight: "light", words),
      v(1em),v(.7em),v(0.8em),v(.7em)
    )
  )
}

#scribe[I dream about space. I dream about monkeys.][]

#scribe[I dream about robots.][monkey robot good sleep]

#scribe[I dream about super powers.][space monster]

#scribe[I dream about food. I dream about sports.][robot]

#scribe[I dream about monsters.][food sport super power]

#scribe[I dream about good sleep.][good happy sad]

#scribe[This face is happy. This face is sad.][super power]

#scribe[This face is sorry. This face is excited.][scared]

#scribe[This face is scared. This face is shy.][sorry mad]

#scribe[This face is mad.][sad scared excited sleepy about]

#scribe[This face is sleepy.][shy sorry sport monster]

#scribe[Racoon is awake. Racoon is hungry.][power food]

#scribe[Racoon is smart.][monkey robot sleepy sorry]

#scribe[Racoon is messy. Racoon is sneaky.][smart happy]

#scribe[Racoon is full.][awake hungry messy sneaky shy]

#scribe[Racoon is sleepy. Racoon is cute.][full scared]

#scribe[This is a potato. This is broccoli.][cute awake]

#scribe[This is lettuce. This is corn.][mad potato messy]

#scribe[This is a chile pepper. This is cabbage.][scared]

#scribe[These are carrots.][face full broccoli lettuce]

#scribe[These are vegetables.][cabbage potato carrot]

#scribe[This is my eye. This is my eyebrow.][cute corn]

#scribe[This is my ear.][sleepy eye awake smart hungry]

#scribe[This is my cheek. This is my nose. This is my mouth.][vegetables]

#scribe[This is my chin. This is my face.][eyebrow nose mouth chin cheek]

#scribe[This room is clean. This room is not clean.][shoe ear eye mouth]

#scribe[This shoe is clean. This shoe is not clean. This hand is clean.][sad]

#scribe[This hand is not clean. This food is clean.][hand food chile pepper]

#scribe[This food is not clean. Some grandparents cook.][swim hike room]

#scribe[Some grandparents swim. Some grandparents hike.][lettuce food]

#scribe[Some grandparents golf. Some grandparents sew.][clean nose eye]

#scribe[Some grandparents garden. Some grandparents paint.][cook corn]

#scribe[Some grandparents read.][golf sew garden paint read happy space]

#scribe[I can skate fast. I can skate slow. I can skate forward.][read clean]

#scribe[I can skate backward. I can spin. I can jump. I can fall.][fast cheek]

#scribe[I can have fun.][slow forward backward spin jump fall fun racoon]

#scribe[I put on my shirt. I put on my pants. I put on my belt.][shirt paint]

#scribe[I put on my socks. I put on my shoes. I put on my glasses.][scared]

#scribe[I put on my jacket. I put on my backpack.][pants belt sock broccoli]

#scribe[This is my foot. This is my leg. This is my belly.][jacket shoe skate]

#scribe[This is my chest. This is my hand. This is my arm.][foot leg face]

#scribe[This is my head. This is my body.][chest hand eye vegetables fun]

#scribe[I smell turkey. I smell stuffing. I smell rolls. I smell yams][foot leg]

#scribe[I smell potatoes. I smell gravy. I smell pie. I smell Thanksgiving!][]

#scribe[I can run. I can jump. I can swing. I can hop. I can ride.][belly]

#scribe[I can climb. I can crawl. I can play.][head turkey body stuffing]

#scribe[Dogs make me happy. Cats make me happy.][sock roll hand]

#scribe[Bubbles make me happy. Trains make me happy.][gravy pie put on]

#scribe[Swings make me happy. Flowers make me happy.][run smell golf]

#scribe[Books make me happy. Friends make me happy.][Thanksgiving]

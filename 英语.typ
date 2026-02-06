
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
      stroke: (_, y) => if y > 0 {(bottom: (paint: gray, thickness: 0.6pt, dash: "dotted"))},
      text(16pt, font: "Playwrite NZ Basic Guides", sentences)
      + h(2em) + text(16pt, font: "Playwrite NZ Basic", weight: "light", words),
      v(1em),v(2.5pt),v(3.5pt),v(2.5pt)
    )
  )
}

#scribe[I dream about space. I dream about monkeys.][space dream about]

#scribe[I dream about robots. I dream about super powers.][monkey robot]

#scribe[I dream about food. I dream about sports.][robot food sport power]

#scribe[I dream about monsters. I dream about good sleep.][monster good]

#scribe[This face is happy. This face is sad.][happy sad super power sleep]

#scribe[This face is sorry. This face is excited.][scared sorry mad sport]

#scribe[This face is scared. This face is shy. This face is mad.][sad shy]

#scribe[This face is sleepy.][scared shy sleepy sorry scared excited mad]

#scribe[Racoon is awake. Racoon is hungry. Racoon is smart.][sleepy sad]


#scribe[Racoon is messy. Racoon is sneaky. Racoon is full.][awake hungry]

#scribe[Racoon is sleepy. Racoon is cute.][messy sneaky full scared happy]

#scribe[This is a potato. This is broccoli. This is lettuce. This is corn.][mad]

#scribe[This is a chile pepper. This is cabbage. These are carrots.][face full]

#scribe[These are vegetables.][broccoli lettuce cabbage potato carrot corn]

#scribe[This is my eye. This is my eyebrow. This is my ear.][eye ear potato]

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




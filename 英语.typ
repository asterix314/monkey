
#set page(
  paper: "a4",
  margin: (x: 1cm, bottom: 2cm),
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
  background: place(top + center, dy: 1.2em,
    table(
      columns: (19cm),
      inset: 0pt,
      stroke: (_, y) => 
      if calc.rem(y, 4) == 0 or calc.rem(y, 4) == 3 {
        (bottom: (paint: gray, thickness: 0.6pt))
      } else {
        (bottom: (paint: gray, thickness: 0.6pt, dash:"dashed"))
      },
      ..6 * (v(87pt), v(.37em), v(.51em), v(.37em))
    )
  ),
  footer: context {
    set text(font: "Segoe Script", size: 14pt)
    align(center)[-- #counter(page).display() --]
  },
)

#set text(24pt, font: "Playwrite NZ Basic Guides")
#set par(leading: 4em, spacing: 4em)


#let vocab = text.with(24pt, font: "Playwrite NZ Basic", weight: "light")


I dream about space. 
I dream about monkeys. 
I dream about robots. 
I dream about super powers.
I dream about food. 
I dream about sports.
I dream about monsters.
I dream about good sleep.
#vocab[space monkey robot super power food sport monster good sleep]

This face is happy. 
This face is sad.
This face is sorry.
This face is excited.
This face is scared. 
This face is shy.
This face is mad.
This face is sleepy.
#vocab[happy sad sorry excited scared shy mad sleepy]

Racoon is awake. 
Racoon is hungry.
Racoon is smart.
Racoon is messy. 
Racoon is sneaky.
Racoon is full.
Racoon is sleepy. 
Racoon is cute.
#vocab[awake hungry smart messy sneaky full sleepy cute]

This is a potato.
This is broccoli.
This is lettuce. 
This is corn.
This is a chile pepper. 
This is cabbage.
These are carrots.
These are vegetables.
#vocab[potato broccoli lettuce corn chile pepper cabbage carrot vegetable]

This is my eye. 
This is my eyebrow.
This is my ear.
This is my cheek. 
This is my nose. 
This is my mouth.
This is my chin. 
This is my face.
#vocab[eye eyebrow ear cheek nose mouth chin face]

This room is clean. 
This room is not clean.
This shoe is clean. 
This shoe is not clean. 
This hand is clean.
This hand is not clean. 
This food is clean.
This food is not clean.
#vocab[room shoe hand food]

Some grandparents cook.
Some grandparents swim. 
Some grandparents hike.
Some grandparents golf. 
Some grandparents sew.
Some grandparents garden. 
Some grandparents paint.
Some grandparents read.
#vocab[cook swim hike golf sew garden paint read]

I can skate fast. 
I can skate slow.
I can skate forward.
I can skate backward.
I can spin. 
I can jump. 
I can fall.
I can have fun.
#vocab[fast slow forward backward spin jump fall fun]

I put on my shirt. 
I put on my pants. 
I put on my belt.
I put on my socks. 
I put on my shoes. 
I put on my glasses.
I put on my jacket. 
I put on my backpack.
#vocab[shirt pants belt sock shoe glass jacket backpack]

This is my foot.
This is my leg. 
This is my belly.
This is my chest. 
This is my hand. 
This is my arm.
This is my head. 
This is my body.
#vocab[foot leg belly chest hand arm head body]

I smell turkey. 
I smell stuffing. 
I smell rolls. 
I smell yams.
I smell potatoes. 
I smell gravy. 
I smell pie. 
I smell Thanksgiving!
#vocab[turkey stuffing rolls yam potato gravy pie Thanksgiving]

I can run. 
I can jump. 
I can swing. 
I can hop. 
I can ride.
I can climb. 
I can crawl. 
I can play.
#vocab[run jump swing hop ride climb crawl play]

Dogs make me happy. 
Cats make me happy.
Bubbles make me happy. 
Trains make me happy.
Swings make me happy. 
Flowers make me happy.
Books make me happy. 
Friends make me happy.
#vocab[dog cat bubble train swing flower book friend]
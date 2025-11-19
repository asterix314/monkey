#import "@preview/fletcher:0.5.8" as fletcher: diagram, edge, node
#import "@preview/suiji:0.5.0" as suiji

#set page(
  paper: "a4",
  margin: (
    top: 3em,
    bottom: 3em,
    x: 2em,
  ),
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
    [两位数加一位数]
  },
  footer: context {
    set text(font: "Segoe Script", size: 14pt)
    align(center)[-- #counter(page).display() --]
  },

  // background: rotate(
  //   24deg,
  //   text(
  //     size: 140pt,
  //     //      weight: "bold",
  //     fill: red.lighten(70%),
  //     font: "Microsoft YaHei",
  //   )[*SAMPLE\ 样例*],
  // ),
)

#set text(18pt, font: "Segoe Script", weight: "bold")

#{
  let to-diagram(x1, x2) = {
    let n = node.with(width: 2em, height: 1.2em)
    let graph = none

    if x1 > x2 {
      let (a, plus, b, a1, a2, a2b, ab) = (
        (1, 0),
        (2, 0),
        (3, 0),
        (.4, 1),
        (1.6, 1),
        (2.2, 2),
        (1.8, 3),
      )
      graph = {
        n(a, [#x1], stroke: none)
        n(plus, [+], stroke: none)
        n(b, [#x2], stroke: none)
        n(a1)
        n(a2)
        n(a2b)
        n(ab)
        edge(a, a1)
        edge(a, a2)
        edge(a2, a2b)
        edge(b, a2b)
        edge(a1, ab)
        edge(a2b, ab)
      }
    } else {
      let (a, plus, b, b1, b2, ab1, ab) = (
        (1, 0),
        (2, 0),
        (3, 0),
        (2.4, 1),
        (3.6, 1),
        (1.8, 2),
        (2.2, 3),
      )
      graph = {
        n(a, [#x1], stroke: none)
        n(plus, [+], stroke: none)
        n(b, [#x2], stroke: none)
        n(b1)
        n(b2)
        n(ab1)
        n(ab)
        edge(b, b1)
        edge(b, b2)
        edge(b1, ab1)
        edge(a, ab1)
        edge(ab1, ab)
        edge(b2, ab)
      }
    }

    return diagram(
      node-stroke: 1pt,
      node-corner-radius: 5pt,
      node-shape: rect,
      edge-stroke: 0.5pt,
      spacing: (.4em, 0.6em),
      graph,
    )
  }

  let exercises(size) = {

    let rng = suiji.gen-rng-f(datetime.today().ordinal())

    let test((x, y)) = {
      let x1 = calc.rem(x, 10)
      return x1 not in (0, 9) and y > 1 and x1 + y <= 9
    }

    let pairs = ()  // ((43, 5), ...)
    (rng, pairs) = suiji.choice-f(rng, replacement: false, size: size,
      range(111, 982)
        .map(
          x => (calc.quo(x, 10), calc.rem(x, 10)))
        .filter(test))

    let switch = ()
    (rng, switch) = suiji.integers-f(rng, endpoint: true, size: size,
      low: 0, high: 1)

    return pairs.zip(switch)
      .map(
        (((x, y), s)) => if s == 1 {to-diagram(x, y)} else {to-diagram(y, x)})
  }

  table(
    columns: 3 * (1fr,),
    align: center,
    stroke: 0.5pt,
    inset: 12pt,
    ..exercises(150)
  )
}

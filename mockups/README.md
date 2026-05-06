# CSK · Exploración de direcciones de UI

Cinco mockups estáticos (HTML standalone, sin build, sin JS) para comparar direcciones visuales antes de tocar el layout V3 actual. Cada archivo entra en una ventana de **1100×760** — el tamaño real de `tauri.conf.json`. Abrilos directo en cualquier navegador.

Los datos son verosímiles (PolyMarket, server, PetsNew, PRs reales-ish, hallazgos de drift/permisos) para que se pueda evaluar la dirección sin tener que imaginar el contenido. Toda la copy está en castellano rioplatense.

---

## 1. `01-zen.html` — Minimal Zen (editorial)

**Dirección.** Tipografía editorial (Fraunces serif) sobre papel blanco roto, casi un diario personal. Headline gigante con la pregunta del día — *"Hoy seguís con PolyMarket, ¿arrancamos por el último commit?"* — y abajo una tira de cuatro números (CRIT/WARN/PRs/proyectos), una cronología de "Hoy", y los tabs convertidos en linkitos al pie. Sin sidebar, sin panel derecho, sin status bar de 28px.

**Dolor que resuelve.** El V3 actual tiene mucho chrome (topbar 52 + sidebar + panel derecho + statusbar 28) que comprime la zona de contenido a ~700×680. Este zen libera 1100 de ancho completo y obliga a que CSK responda *una pregunta concreta cada vez que abrís la app*.

**Tradeoffs vs V3.**
- Pro: contenido manda, calma visual, sensación de "esto es mío" más que "esto es un dashboard".
- Contra: la nav inferior de 7 items es menos descubrible que el sidebar; el companion no aparece (habría que repensarla como overlay o pestaña dedicada); usuarios power van a extrañar densidad.

---

## 2. `02-command-palette.html` — Command-palette-centric (Linear/Raycast)

**Dirección.** Oscuro, mono (JetBrains Mono), rail de íconos de 48px en lugar de sidebar completa, y el ⌘K abierto en el centro de la pantalla como ciudadano de primera clase. La hero card del proyecto activo y los "atajos sugeridos" están construidos como si fueran ítems de paleta — todo es ejecutable por teclado. Glow verde menta + acentos azules.

**Dolor que resuelve.** En V3 hay 7 tabs + N proyectos + N hallazgos + N PRs y para llegar a cualquier acción concreta hacés varios clicks. Acá el ⌘K te lleva a *"resolver crítico drift en hooks"* en dos teclas.

**Tradeoffs vs V3.**
- Pro: power-users felices, navegación ultra-rápida, el contenido respira más.
- Contra: usuarios que descubren features clickeando van a perderse; mantener el catálogo de comandos sincronizado con cada nueva feature es trabajo extra; menos "shoppable" — abrir CSK por primera vez no muestra todo lo que sabe hacer.

---

## 3. `03-workspace-hero.html` — Workspace card como hero (editorial cálido)

**Dirección.** Papel beige con grilla sutil, Instrument Serif para el nombre del proyecto, Inter Tight para el resto. La tarjeta del proyecto activo ocupa el tercio superior con su quote en cursiva + tres campos (objetivo / estado / próximo paso). Debajo, tres columnas iguales: hallazgos del día, PRs por revisar, limpieza sugerida. Tabs como una tira textual arriba a la derecha.

**Dolor que resuelve.** El Overview de V3 actual lista cosas (greeting + counts + last commit) pero no contesta *"¿qué hago primero?"*. Acá el proyecto del día es el hero literal, con su objetivo y próximo paso explícitos, y los tres paneles de abajo son las tres acciones posibles del día.

**Tradeoffs vs V3.**
- Pro: super legible, sensación premium, la app se siente "mi cuaderno" más que "mi dashboard"; las decisiones del día son obvias en 5 segundos.
- Contra: si no hay proyecto activo "del día" la hero queda hueca; necesita lógica para decidir qué proyecto es el del día (último commit? engram preference? ambas?); menos útil cuando trabajás en 3 proyectos en paralelo.

---

## 4. `04-data-dense.html` — Data-dense / power-user

**Dirección.** Bloomberg/k9s-style. IBM Plex Mono + Plex Sans, fuente 11.5px de base, tablas reales con sev-cat-proyecto-hallazgo-edad-acción, sparklines en los KPIs, heatmap de actividad de 14 días en el panel derecho, sidebar con 14 proyectos visibles a la vez con dots de severidad por proyecto. Fondo casi negro, acento verde menta.

**Dolor que resuelve.** El V3 actual está pensado para ~5–10 proyectos. Para usuarios con 50+ repos esto es lo único que escala — sidebar densa, KPIs comparables con su delta, tablas filtrables, todo navegable con teclado.

**Tradeoffs vs V3.**
- Pro: cabe muchísima información en 1100×760; el "estado del workspace" es legible de un golpe; identidad de "herramienta seria de developer".
- Contra: pierde calidez (la companion queda como una línea de texto); puede intimidar a usuarios casuales; tipografía mono pesa visualmente y cansa más rápido que la actual; los themes playful (lilac-stickers, y2k-pop) no encajan en este molde.

---

## 5. `05-companion-first.html` — Anime / playful identity

**Dirección.** La compañera (Akira-chan, gata sprite CSS-only con orejas, moño y bubble de diálogo) ocupa el 65% izquierdo como ciudadana de primera. Skills/engram/commits se vuelven barras de stats RPG (HP/MP/EXP). Las tareas del día son "misiones" con XP. Paleta rosa-pastel + lavanda + menta, fuente Zen Maru Gothic + DotGothic16 pixel para los labels, todo con border 3px y box-shadow dura tipo sticker.

**Dolor que resuelve.** Ningún tema actual de los 15 V3 *abraza* la decisión de tener una companion anime — la dejan como widget de 200px en el panel derecho. Esta dirección se la juega: si la companion es la idea diferenciadora del producto, ponerla al frente lo hace memorable de verdad.

**Tradeoffs vs V3.**
- Pro: identidad altísima, diferenciación brutal, hace que abrir CSK sea *agradable* y no funcional; las tareas como misiones bajan la fricción para arrancar el día.
- Contra: rotundamente no es para todos — hay devs que no quieren un sprite hablándoles; difícil escalar a temas serios (blueprint, cyber-terminal); densidad baja, no aguanta 50 proyectos; convierte a CSK en "la app de la gata" para bien o para mal.

---

## Cómo evaluar

Sugerencia: abrí los 5 en pestañas separadas, **resizeá la ventana del navegador a 1100×760 exactos** (DevTools → Device Mode → 1100×760) y hacé switch entre tabs. La dirección que querés mantener abierta más tiempo gana.

Tres preguntas guía:
1. Si abrís CSK por la mañana, ¿cuál te dice más rápido qué hacer hoy?
2. Si tenés 50 proyectos en disco, ¿cuál sigue siendo usable?
3. ¿Cuál se siente *tuyo* y no genérico?

No hay obligación de elegir uno: el zen + workspace-hero se pueden hibridar; el command-palette es un overlay que se le puede sumar a cualquiera; el data-dense puede ser un "modo power" alternativo; la companion puede ser un theme entre los 15.

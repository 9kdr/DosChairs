// Every line of text in the promo lives here. Edit, then run `npm run render`.
// `hold` / `dur` are seconds; the total length follows from them.
window.SCRIPT = {
  // Mel's voiceover script, verbatim in `say` (not shown on screen; it sets the
  // pace). `cue` holds stage directions / sound notes (never shown either).
  // `show` is the kinetic phrase on screen. `visual` picks the backdrop:
  // cursor | type | montage | pullback | dissolve | switch | brand.
  intro: [
    { part: "Part 1", cue: "[I'm an expressive mouse on a desktop] Tape sound, riser", visual: "cursor", dur: 4.5 },
    { say: "AI is going to replace video editors.", show: "AI is going to replace video editors.", visual: "type", dur: 3.5 },
    { cue: "Hungarian Dance No. 5 begins. [Montage, getting louder the more time passes]", visual: "montage", show: "MONTAGE", dur: 10 },
    { cue: "Reverb, match key, Reverse Reverb, pick back up music", say: "That's what I keep hearing. Over, and over again.", show: "Over, and over again.", visual: "cursor", mood: "pace", dur: 4 },
    { cue: "dynamically animated mouse to express", say: "Many people believe that, and I understand why. All the videos in the montage you just saw were made with AI!", show: "Made with AI.", visual: "grid", dur: 6 },
    { say: "I'm not convinced though.", show: "I'm not convinced.", visual: "cursor", mood: "shake", dur: 3 },
    { cue: "** the content zoom out is too harsh here, bring it down with an analogy (gentle pull-back)", say: "We're now entering an era where any individual with knowledge of AI can produce something that looks professional.", show: "Anyone can look professional.", visual: "pullback", dur: 7 },
    { say: "This sounds positive at first glance, listen carefully though: the Key words \"Knowledge of AI.\"", show: "Knowledge of AI.", visual: "type", accent: "of AI.", dur: 6 },
    { say: "The videos in that montage were actually made by real editors that happen to know how to use AI…", show: "Made by real editors.", visual: "type", accent: "real editors.", dur: 5 },
    { say: "For most, the foundations, the taste, the core of what gives videos their quality, is slowly being lost.", show: "the foundations · the taste · the core", visual: "dissolve", dur: 7.5 },
    { say: "Not because AI is bad at editing, no, not at all, but because these ultra productive AI tools are made for people who don't really know how to edit.", show: "Made for people who don't edit.", visual: "type", dur: 8.5 },
    { say: "Like honestly, no video editor will switch to another piece of software that doesn't feel anywhere nearly as good for the sake of not falling behind.", show: "No editor switches to something worse.", visual: "type", dur: 8 },
    { say: "It was already incredibly hard for me to switch to Davinci Resolve from Vegas Pro, I can't even begin to imagine that.", show: "Vegas Pro → DaVinci Resolve", visual: "switch", dur: 6.5 },
    { say: "So, yes, even though AI is good at video editing, there's a problem:", show: "There's a problem:", visual: "type", dur: 4 },
    { say: "It still needs video editors, and we're actively killing them by trying to sidestep them.", show: "It still needs video editors.", visual: "type", accent: "video editors.", dur: 6 },
    { cue: "[Curious Music]", say: "This led me to ask the question: Is there anything better? Is there a way for editors to survive this rampage?", show: "Is there anything better?", visual: "cursor", mood: "curious", dur: 7 },
    { say: "Maybe, with harmony, and a Chair.", show: "Maybe, with harmony, and a Chair.", visual: "type", accent: "a Chair.", dur: 4 },
    { part: "Part 2", cue: "[Blank screen, slight botanica sfx, Title \"Chair\" changing fonts a few times, serene]", visual: "brand", dur: 5 },
    { say: "I edited this video on a Chair.. Well actually two. This is Chair, my attempt at finding a middle ground.", show: "my attempt at finding a middle ground.", visual: "brand", settled: true, dur: 7 },
  ],
  features: {
    flow: {
      dur: 10, label: "Task flow",
      title: "Say it once.\nWatch it run.",
      sub: "The command bar hands your ask to an orchestrator. It plans, then tool agents run each task as a card.",
      command: "Add a title piece for the intro and duck the music under dialogue",
      plan: ["Read the cut", "Generate title piece", "Place piece on a new track", "Duck music under dialogue"],
      tasks: ["Title piece", "New track V3", "Music ducking"],
    },
    copies: {
      dur: 8, label: "Never destructive",
      title: "Every edit\nlands on a copy.",
      sub: "A new timeline, a new comp version, a new track. Your cut is never touched. One key undoes it.",
      history: ["Opened Summer Reel", "Title piece → V3 on a copy", "Music −9 dB under dialogue"],
    },
    resolve: {
      dur: 7.5, label: "Resolve-native",
      title: "Lives inside\nDaVinci Resolve.",
      sub: "Open a project in Chair and Resolve opens on it. Pieces land as native, keyframable Fusion comps.",
    },
    pieces: {
      dur: 8.5, label: "Pieces",
      title: "Motion graphics\nfrom a sentence.",
      sub: "Web-tech pieces generated by Muse Spark. Transparent by default, baked fast on the GPU.",
      prompt: "Kinetic lower third, soft grain",
      bake: "8 s · 1080p baked in 17 s", cached: "Re-apply from cache 0.3 s",
    },
    shelf: {
      dur: 7.5, label: "The Shelf",
      title: "Assets and pieces\nin one place.",
      sub: "Search everything, filter by kind: All, Media, Pieces, Sounds.",
      search: "lower",
    },
    rig: {
      dur: 10, label: "Effect Maker",
      title: "Rigs that\nmove like they mean it.",
      sub: "Generated rigs, like a cursor on a pendulum that swings with acceleration. Keyframe the target, no tracking.",
      prompt: "Expressive cursor that swings on a pendulum",
    },
    sound: {
      dur: 7, label: "Sound",
      title: "Sound that\nfinds its place.",
      sub: "Chair picks and places SFX like risers, and ducks music under dialogue.",
    },
    suggest: {
      dur: 6.5, label: "Suggestions",
      title: "Next steps\ncome from the plan.",
      sub: "Unrun steps become suggestions. Failures get a Retry.",
      chips: ["Run: Color match shots 3–5", "Retry: Render preview", "Run: Export captions"],
    },
    models: {
      dur: 6, label: "Models",
      title: "One plans.\nOne executes.",
      sub: "Muse Wonder plans the edit. Muse Spark runs each task and verifies it.",
    },
  },
  outro: {
    dur: 7, word: "Chair",
    tagline: "Never destructive. Always undoable.",
    url: "github.com/9kdr/DosChairs",
  },
};

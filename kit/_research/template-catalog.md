<!--
  Forevermore — template / world catalog
  RECONSTRUCTED 2026-07-13 after kit loss (git clean -fd wiped the untracked
  marketing/ kit). Owner review pending.

  Source of truth: regenerated from the platform template registry
  (packages/templates/src/<slug>/manifest.ts via registry.ts) — the same
  upstream this file was always projected from. slug / name / tier / isActive /
  description are copied verbatim from each manifest; array order follows the
  registry sortOrder. 45 worlds, 33 active / 12 inactive.

  Consumed by: src/lint/rules/world-checks.mjs (active-world gate),
  src/lint/rules/style.mjs (proper-noun mask), src/brain/assemble.mjs
  (loadWorldFacts / worldFactsForIdea). Parser reads the FIRST fenced json
  block below (src/lint/catalog.mjs#parseCatalogMarkdown).
-->

# Template catalog

```json
[
  {
    "slug": "memory-timeline",
    "name": "Ribbon Path",
    "tier": "standard",
    "isActive": true,
    "description": "A little car drives through a neighbourhood street, stopping at each photo memory along the way, then arrives at a final message — the completed route becomes the keepsake."
  },
  {
    "slug": "memory-ride",
    "name": "Memory Ride",
    "tier": "premium",
    "isActive": true,
    "description": "A cinematic guided ride through a personalized world of photo memories."
  },
  {
    "slug": "gallery-wall",
    "name": "Gallery Wall",
    "tier": "standard",
    "isActive": false,
    "description": "A tiny private gallery on opening night: unwrap each wrapped canvas, hang it on its marked hook, and its picture light clicks on — until the vernissage unveils the plaque with their name and your dedication is read under the lamps."
  },
  {
    "slug": "memory-museum",
    "name": "Memory Museum",
    "tier": "standard",
    "isActive": false,
    "description": "A private museum built about one person — unveil every exhibit, wing by wing, until the whole building is lit."
  },
  {
    "slug": "open-when-letter",
    "name": "Open When Letters",
    "tier": "standard",
    "isActive": true,
    "description": "A lamplit keepsake box of sealed \"open when…\" letters. They crack each wax seal, unfold your words, and tuck the photos into the lid — until the letter you saved for last is theirs to keep."
  },
  {
    "slug": "keepsake-desk",
    "name": "Keepsake Desk",
    "tier": "premium",
    "isActive": true,
    "description": "A candlelit desk of keepsake objects, notes, photos, and a final letter reveal."
  },
  {
    "slug": "constellation-reveal",
    "name": "Constellation Reveal",
    "tier": "standard",
    "isActive": true,
    "description": "A quiet night sky where each photo is a star. Every memory opened leaves a trace of starlight, until the final star connects the constellation above the closing message."
  },
  {
    "slug": "star-map-letter",
    "name": "Star Map Letter",
    "tier": "standard",
    "isActive": false,
    "description": "A night-sky letter where stars open memories and connect into a final message."
  },
  {
    "slug": "starlit-letter",
    "name": "Starlit Letter",
    "tier": "premium",
    "isActive": true,
    "description": "A cinematic star journey ending in a custom constellation and final message."
  },
  {
    "slug": "blooming-garden",
    "name": "Blooming Message Garden",
    "tier": "standard",
    "isActive": true,
    "description": "A quiet garden that grows as memories are planted. Each photo unfurls into a flower, until the final bloom opens with the message at the heart of a garden grown just for them."
  },
  {
    "slug": "birthday-bloom",
    "name": "Birthday Bloom",
    "tier": "standard",
    "isActive": false,
    "description": "A soft blooming page where flowers reveal photos, captions, and a bouquet finale."
  },
  {
    "slug": "memory-garden",
    "name": "Memory Garden",
    "tier": "premium",
    "isActive": true,
    "description": "A bright little clay garden planted one seed at a time — drop each memory into the soil and watch it bloom."
  },
  {
    "slug": "memory-map",
    "name": "Memory Map",
    "tier": "standard",
    "isActive": false,
    "description": "A hand-painted storybook map of your places: a paper boat sails stop to stop, each landing paints that corner of the world in watercolor around its photo — until the whole map is painted, titled with their name, and your letter unrolls at Home."
  },
  {
    "slug": "our-little-world",
    "name": "Our Little World",
    "tier": "premium",
    "isActive": false,
    "description": "A tiny world under glass: wind the key and watch your life together get built, zone by zone, by a little wooden train."
  },
  {
    "slug": "polaroid-envelope",
    "name": "Polaroid Envelope",
    "tier": "standard",
    "isActive": true,
    "description": "A sealed envelope that opens to reveal pull-out polaroids — each with its own handwritten caption — plus an opening note and a closing message."
  },
  {
    "slug": "memory-arcade",
    "name": "Memory Arcade",
    "tier": "standard",
    "isActive": true,
    "description": "A playful block-world quest where each memory unlocks a tile, lights the trail, and the completed map becomes the keepsake — a gift built for kids, siblings, grandchildren and proud-of-you moments."
  },
  {
    "slug": "sticker-book",
    "name": "Sticker Book",
    "tier": "standard",
    "isActive": true,
    "description": "A playful sticker album page: every photo becomes a die-cut sticker peeled from a shiny pack and pressed into its waiting spot, until the completed page is sealed with a gold title sticker above the final message."
  },
  {
    "slug": "pocket-pal",
    "name": "Pocket Pal",
    "tier": "standard",
    "isActive": true,
    "description": "A pastel handheld hatches a tiny pixel pal that grows with every memory — feed it, play with it, tuck it in, and watch it evolve until it bursts off the screen holding your message."
  },
  {
    "slug": "drive-in-night",
    "name": "Drive-In Night",
    "tier": "premium",
    "isActive": true,
    "description": "A private drive-in premiere of a film about them — acts, subtitles, credits, and a marquee with their name."
  },
  {
    "slug": "gone-fishing",
    "name": "Gone Fishing: First Light",
    "tier": "premium",
    "isActive": true,
    "description": "A dawn-to-sunset fishing trip where every memory is reeled in as a glowing catch."
  },
  {
    "slug": "memory-mine",
    "name": "The Memory Mine",
    "tier": "premium",
    "isActive": true,
    "description": "A playable pixel world: dig through a torch-lit mine, open memory chests, and spend six hard-won gems to unlock the vault holding your message."
  },
  {
    "slug": "mixtape-side-a",
    "name": "Mixtape: Side A",
    "tier": "standard",
    "isActive": true,
    "description": "A hand-labeled cassette made just for them: every memory is a track, the reels spin, titles write themselves onto the J-card, and the finished mixtape unfolds into liner notes around your message."
  },
  {
    "slug": "matchday",
    "name": "Matchday: Starting XI",
    "tier": "standard",
    "isActive": true,
    "description": "A matchday teamsheet ceremony: every photo is a squad member called up and sent onto the pitch, the stadium comes alive as the XI fills, and the finished squad gathers for the classic team photo with your message on the big screen. Built for group gifts."
  },
  {
    "slug": "fairground",
    "name": "The Fairground",
    "tier": "premium",
    "isActive": true,
    "description": "A cozy toy-scale night fair strung with warm lights, where a little companion strolls booth to booth winning your photos and toys, ending with a Ferris-wheel ride as fireworks bloom."
  },
  {
    "slug": "passport",
    "name": "Passport",
    "tier": "standard",
    "isActive": true,
    "description": "A well-worn passport for the traveler: each memory is a destination stamped onto the page with its photo and a boarding-pass stub, the world map lights pin by pin, and a final boarding pass carries the message home — the final destination."
  },
  {
    "slug": "manor",
    "name": "The Manor",
    "tier": "premium",
    "isActive": true,
    "description": "Walk a cozy open-roof manor room by room, wake each memory, and unlock the garden finale with a ring of brass keys."
  },
  {
    "slug": "wonderways",
    "name": "Wonderways",
    "tier": "premium",
    "isActive": true,
    "description": "Turn the pieces of an impossible world until each path connects and a light carries a memory home — dawn to dusk, until the final turn builds one glowing tower from everything you solved."
  },
  {
    "slug": "paper-wishes",
    "name": "Paper Wishes",
    "tier": "standard",
    "isActive": true,
    "description": "Fold a garden of paper wishes, one crease at a time — each finished crane, boat, or lotus opens to a memory, until the last fold sends the whole flock up to carry your message."
  },
  {
    "slug": "quest-book",
    "name": "The Questbook",
    "tier": "premium",
    "isActive": true,
    "description": "A pop-up book of challenges only they can answer — every right one folds the next paper world upright, until the last page opens the treasure."
  },
  {
    "slug": "long-way-home",
    "name": "The Long Way Home",
    "tier": "premium",
    "isActive": true,
    "description": "Step off the train into a town built about you — every neighbour on the walk home has a memory or a question, and by your front door the whole town is walking with you."
  },
  {
    "slug": "blockheart-mine",
    "name": "The Blockheart Mine",
    "tier": "premium",
    "isActive": true,
    "description": "A fully-3D voxel world you explore in first person: take the pickaxe from the spawn chest, follow torch-lit signs underground, uncover framed memories in the caverns, mine six heart-gems, and set them into the vault door to reach the golden room and your message."
  },
  {
    "slug": "deep-reef-dive",
    "name": "Deep Reef Dive",
    "tier": "premium",
    "isActive": true,
    "description": "Sink through a sunlit reef into the glowing deep. Every fathom down, a shell opens to hold one of your photos — and a letter waits in the grotto at the bottom."
  },
  {
    "slug": "dune-glider",
    "name": "Dune Glider",
    "tier": "standard",
    "isActive": true,
    "description": "Carve down endless dunes under a slow-turning sky. Your photos ride the wind as lantern-kites to catch mid-flight — and a letter waits at the temple where the ride comes to rest."
  },
  {
    "slug": "prize-claw",
    "name": "The Prize Claw",
    "tier": "standard",
    "isActive": true,
    "description": "A pastel claw machine stocked just for them: insert the coin, press the glowing button, and win every capsule memory one grab at a time — until the machine hits JACKPOT and the golden ticket carries your message."
  },
  {
    "slug": "moving-day",
    "name": "Moving Day",
    "tier": "standard",
    "isActive": true,
    "description": "A little room furnished box by box: every memory unpacks into a frame on the wall and something warm for the shelves, daylight rolls toward dusk as the home fills — and the ribbon-tied last box holds your letter."
  },
  {
    "slug": "golden-claw",
    "name": "The Golden Claw",
    "tier": "premium",
    "isActive": false,
    "description": "The arcade stayed open late, just for them: a glowing claw machine stocked with capsule memories, endless tokens, and controls in their hands. Every prize is won, not shown — until the golden capsule drops and your letter is the jackpot."
  },
  {
    "slug": "paint-by-heart",
    "name": "Paint by Heart",
    "tier": "standard",
    "isActive": false,
    "description": "A paint-by-number canvas made from your photos: every numbered pot holds one memory, every memory paints its patch of the picture, and the last stroke earns the frame, the signature — and your letter."
  },
  {
    "slug": "encore",
    "name": "Encore",
    "tier": "standard",
    "isActive": false,
    "description": "Their own sold-out show: name up in marquee bulbs, memories as the setlist. Every cheer unrolls a painted backdrop of one photo, the crowd grows with every song — and the encore is your letter."
  },
  {
    "slug": "small-world",
    "name": "Small World",
    "tier": "premium",
    "isActive": false,
    "description": "A pocket planet where everyone knows your name — run the town rounds and every neighbour hands over a photo or a note left in their keeping, until the whole town gathers to see you off."
  },
  {
    "slug": "up-we-go",
    "name": "Up We Go",
    "tier": "premium",
    "isActive": false,
    "description": "A hand-painted hot-air balloon voyage — your memories rise to fly beside them, then glow like lanterns in the dusk."
  },
  {
    "slug": "desert-village",
    "name": "Desert Village",
    "tier": "premium",
    "isActive": false,
    "description": "Walk a warm desert village in third person as your photos appear in lantern-lit alcoves, courtyard walls, and cloth banners — ending in a central square where your letter arrives."
  },
  {
    "slug": "cruise",
    "name": "Sunset Cruise",
    "tier": "premium",
    "isActive": true,
    "description": "An evening voyage along a glowing coast — every memory is lifted aboard as a harbor lantern while the dusk deepens toward a festival cove."
  },
  {
    "slug": "dinner-table",
    "name": "Candlelit Dinner",
    "tier": "premium",
    "isActive": true,
    "description": "A private rooftop table above the evening city — every course is a shared memory, served under a cloche."
  },
  {
    "slug": "love-letters",
    "name": "Love Letters",
    "tier": "premium",
    "isActive": true,
    "description": "A dove post at golden hour — sealed letters arrive over the rooftops one by one, until the whole flock carries in the last."
  },
  {
    "slug": "birthday-trolley",
    "name": "Birthday Trolley",
    "tier": "standard",
    "isActive": true,
    "description": "A double-decker party trolley with a seat saved for everyone: punch the ticket, welcome each photo aboard stop by stop, and ride from noon to lantern-lit night — the last stop is the party."
  }
]
```

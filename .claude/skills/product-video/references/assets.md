# Brand and assets

## Match the brand

The video should look and sound like the product it shows, not like this template. Build a short brand profile before the first scene, from these sources in order of authority:

1. **Brand docs.** Search the repository for brand guidelines, a design system or tone-of-voice notes, for example `docs/brand/`, `brand.md`, `DESIGN.md`, `CONTEXT.md` or the nearest `AGENTS.md`. Approved claims, statistics and product names there override anything you would write yourself.
2. **Design tokens.** Read the CSS custom properties (`:root`, `@theme`), the Tailwind config, theme files, or the token package the apps import. Take the background, surface, text, muted text, accent and status colors, the border radius and the font families with their weights.
3. **Assets.** Find the logo (SVG first) and any existing motion such as a logo intro clip, in places like `public/`, `assets/`, `brand/`, the favicon or the marketing site. Copy them into the build folder. Use the brand intro as the first part of `concat` when one exists.
4. **The running product.** When the app runs, read its real styles in ego-browser. This is the most reliable source when tokens are hard to trace:

   ```js
   console.log(await page.evaluate(() => {
     const css = (selector, ...props) => {
       const el = document.querySelector(selector)
       if (!el) return null
       const style = getComputedStyle(el)
       return Object.fromEntries(props.map((prop) => [prop, style.getPropertyValue(prop)]))
     }
     return {
       body: css('body', 'background-color', 'color', 'font-family'),
       heading: css('h1, h2', 'color', 'font-family', 'font-weight', 'letter-spacing'),
       primaryButton: css('button[type=submit], .btn-primary, [data-variant=primary], button', 'background-color', 'color', 'border-radius'),
       link: css('a', 'color'),
       card: css('[class*=card]', 'background-color', 'border-color', 'border-radius', 'box-shadow'),
     }
   }))
   ```

   Take a screenshot of a typical screen as the visual reference too.
5. **Voice.** Read the marketing site or README for how the product talks: formal or casual, its words for its users and features, and the language. The narration and on-screen text use the same register and terms.

Then set the template's `:root` variables, `--font` and the accent colors from the profile. Match the product's light or dark look, and use its radius and shadows on cards. Put the logo in the opening and the end card. Compare the `stills` contact sheet with the product screenshot: the two should look like the same company. If there is no brand to find, ask the user for colors and a logo, or say that the video uses the neutral template.

## A product that is not in this repository

When the video is about a product the user names (or one you pick, such as a well-known SaaS for a sample launch film), gather the real thing from the internet instead of inventing it. Keep `assets/SOURCES.md` with one line per file: file, URL, date and what it is.

- **Facts:** read the product's homepage, features, pricing and changelog or launch post in ego-browser. Pick the one launch or feature the film is about. Every on-screen claim, number and feature name comes from those pages; note the URL in the brief. Never invent customer counts, ratings or results.
- **Logo:** the SVG in the site header (`document.querySelector('header svg').outerHTML`, or the `img` in the header link), the brand or press page (`/brand`, `/press`, `/media-kit`), or `https://cdn.simpleicons.org/<slug>` for a monochrome mark. Prefer SVG; never trace or redraw a logo.
- **Colors and type:** run the computed-style snippet above on the homepage and on a product page. Use the brand's font when it is a web font you can load (`@font-face` from the site's own CSS, or Google Fonts); otherwise the closest system font, and say so.
- **Product imagery:** in order of preference:
  1. the real product, screenshotted at 2x in ego-browser (`page.screenshot({ path, clip })` per region), signed in with the user's account or a public demo;
  2. product screenshots and videos from the marketing site and launch post (their `img` and `video` sources at full resolution);
  3. the `og:image` and press kit images.
  Crop to the UI itself and put it in a browser or device frame built in HTML, so it can tilt, zoom and focus. Cut UI regions into separate images when a beat needs them to move independently.
- **Video clips:** a recorded live walkthrough (`<part>/video.mp4`) or a short clip from the site can play inside a frame with `<video data-start>`.
- **What to avoid:** stock photos of people pretending to use the product, AI imagery passed off as the real product, screenshots with real customer data, and other brands' logos next to it unless the site itself shows them as integrations.

**Label concept films.** When the product is not the user's own, the end card carries a small line such as "Concept film · not affiliated with <brand>", and you say so when delivering. Use the brand's assets for this sample only; publishing it as an ad for the brand needs the brand's permission.

# Hydration

## Summary

Hydration is enabled by default. `hydration: "none"` still returns complete SSR HTML, CSS, and SEO; it does not return a blank page or turn SSR off.

It only prevents the Vext/React browser runtime from loading. React events, Vext Form, Vext fetcher, and framework-managed client navigation are therefore unavailable, while native HTML behavior still works as the browser normally provides it.

## What default hydration does

Hydration attaches the browser React tree to the HTML produced by SSR. In the default mode, Vext loads its browser entry and attaches the browser React tree to the already visible page, enabling Vext interactions and client navigation.

Vext writes the render payload into the document so the client entry can hydrate without repeating first-screen service calls:

- page id
- props
- layoutData
- locale and messages
- head metadata used for the initial route
- build id and route assets

## Default mode compared with `hydration: "none"`

| Item                   | Default hydration                                                          | `hydration: "none"`                                                               |
| ---------------------- | -------------------------------------------------------------------------- | --------------------------------------------------------------------------------- |
| Initial page load      | The SSR document displays, then the browser runtime loads and hydrates it. | The complete SSR document displays normally; no Vext/React browser runtime loads. |
| SSR HTML               | Returned.                                                                  | The complete page HTML is still returned.                                         |
| CSS                    | Returned and loaded.                                                       | Still returned and loaded.                                                        |
| SEO                    | SSR metadata is available.                                                 | SSR metadata remains available.                                                   |
| React events           | Available after hydration.                                                 | Unavailable; handlers such as `onClick` do not run.                               |
| Vext Form              | Available.                                                                 | Unavailable.                                                                      |
| Vext fetcher           | Available.                                                                 | Unavailable.                                                                      |
| Vext client navigation | Available.                                                                 | Unavailable; navigation requires a full document navigation.                      |
| Normal links           | Available.                                                                 | Still available; the browser performs a normal document navigation.               |
| Normal HTML forms      | Available.                                                                 | Still available; the browser performs a normal form submission.                   |
| Vext browser entry     | Emitted and loaded.                                                        | Not emitted.                                                                      |
| `__VEXT_DATA__`        | Emitted for the client entry to reuse.                                     | Not emitted.                                                                      |
| route JS preload       | Route JS preload is emitted.                                               | Route JS preload is not emitted.                                                  |

## Good and bad fits

### Good fits

- Article detail pages.
- Documentation pages.
- Marketing pages.
- SEO content pages.
- Pages that only need server output.
- Pages whose interaction is handled by independently loaded scripts that you own.

### Not good fits

- Admin pages.
- Rich-text editors.
- React-interactive pages for search, filtering, or pagination.
- Pages that use Vext Form or fetcher.
- Pages that depend on Vext client navigation.

## Opt out for one SSR page

```ts
app.get(
  "/article/:slug",
  { frontend: { hydration: "none" } },
  async (req, res) => {
    const article = await app.services.articles.find(req.params.slug);
    res.render("article", { article }, { seo: { title: article.title } });
  },
);
```

This route behaves as follows:

- Its first visit still returns complete SSR HTML.
- The page displays normally and loads CSS.
- Normal `<a>` links and normal HTML `<form>` elements still work.
- React event handlers such as `onClick` do not run.
- Vext Form, fetcher, and framework-managed same-document navigation do not run.
- Moving from a `none` page to a hydrated page requires a full document navigation; hydration resumes after the destination page loads.

Independently authored scripts that you put in the document are also retained; whether they work depends on the script itself, not on the Vext runtime.

## Capabilities disabled by `none`

A `hydration: "none"` page has no Vext/React browser runtime, so it cannot rely on behavior that the framework takes over after the page loads:

- React event handlers and interactions that depend on React state do not run.
- Vext Form does not take over or enhance forms.
- Vext fetcher does not make framework-managed client requests.
- Vext does not manage same-document client navigation.

Keep the default hydration when the page needs those capabilities, or use standalone scripts that you load and maintain independently of the Vext runtime.

## Whole-document scope and current limitations

`hydration: "none"` applies to the entire document. It cannot disable hydration for only one React component. Vext cannot currently hydrate only a search box, comment area, or another local region.

The current public surface also does not claim Selective/Partial Hydration, Islands, React Server Components, or Partial Prerendering (PPR). Do not treat this route-level switch as a partial-hydration mechanism.

## Why there is no global configuration

The public API currently has no global `hydration: "none"` setting. One application can contain both interactive pages and pure SSR pages; a global opt-out would remove React/Vext client capabilities from every page.

If an entire site needs pure SSR, declare `hydration: "none"` on each route, or generate those route options consistently in your application's own route-registration layer. The latter is an application-level wrapper, not a Vext global configuration API.

## Static route-options grammar

Vext reads each route's hydration policy at build time and uses it to generate
the route manifest and resource inventory. An inline declaration is the
simplest supported form:

```ts
app.get("/article/:slug", { frontend: { hydration: "none" } }, handler);
```

The finite static grammar also accepts same-file `const` objects, TypeScript
static wrappers, and a helper call whose first argument is a projectable
options object. The helper body, imported values, computed expressions, and
interpolated templates are not executed. An unprojectable path or indexed
schema fails with route context rather than being silently omitted. Keep
request-dependent page metadata in `res.render(..., { seo })`.

## Avoid Mismatch

Keep SSR and browser output deterministic:

| Risk                                | Better approach                                         |
| ----------------------------------- | ------------------------------------------------------- |
| `Date.now()` in render output       | Pass a timestamp from the route handler.                |
| random ids in component render      | Generate stable ids before render or in effects.        |
| browser-only APIs during SSR        | Guard with effects or client-only branches.             |
| locale objects with different shape | Keep every locale file aligned with the default locale. |

## Hydration markers

Vext exposes low-noise runtime markers for tests and diagnostics:

```text
data-vext-hydration="hydrating"
data-vext-hydration="done"
performance.measure("vext:hydration")
```

A `hydration: "none"` document is marked with `data-vext-hydration="none"` so diagnostics can identify that the browser runtime is intentionally absent. The browser does not need to print performance logs in production; validation scripts read DOM and Performance API signals.

## Route assets

The render manifest records initial JS/CSS for each route. In the default mode, SSR can inject route-specific `modulepreload` entries so hydration does not discover the page chunk late. `hydration: "none"` does not emit those route JS preloads, but it does not remove CSS.

If production `vext start` sees an outdated manifest without route assets, it fails fast and asks for a rebuild.

## Validation

After editing documentation in this repository, run its documentation contract:

```bash
npm run verify:docs-contract
```

This checks the repository documentation contract; it is not a browser-runtime test. To verify application behavior, use the application's own build, start, and browser-test flow and follow [Hydration validation](./hydration-validation).

For a default-hydration route, expect the browser entry, route JS preload, `data-vext-hydration="done"`, and the `vext:hydration` Performance entry. For a `none` route, expect SSR HTML/CSS/SEO and `data-vext-hydration="none"`, but not the Vext browser entry, `__VEXT_DATA__`, route JS preload, the `done` marker, or the hydration Performance entry.

<!-- Maintainer-only contract note: E:\Worker\vextjs-test is a machine-specific local companion project, not a public Vext command or path for readers to copy. -->

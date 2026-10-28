# Widget gallery previews

These PNG images are screenshots of the templates in
`src/lib/build/widget-templates.ts`, rendered by the same sandbox used in the
widget editor. They use example data and a light preview theme, independent of
the surrounding product theme. They are not screenshots of an external product.

When a template changes, open it from Widgets > Templates, choose Use template,
and capture its rendered default state from the editor preview without saving.
Keep the preview canvas at roughly 600 px wide, scroll to the top, and crop the
canvas to a 6:5 image. Check the captured pixels before replacing the matching
PNG; browser captures must include the rendered sandbox iframe. Close the draft
after capturing. The gallery uses Next Image for responsive, lazy-loaded images.

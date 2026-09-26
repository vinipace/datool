# Third-party notices

Datool's original source is licensed under Apache-2.0. Dependencies and brand
assets retain their own licenses; the root license does not relicense them.
Keep upstream license and notice files when redistributing bundled dependencies.

The lockfiles identify the exact npm and Python dependencies. Installed packages
include their license information. Public source exports do not include
`node_modules`, Python environments, generated Monaco bundles, or Docker images.

## Components requiring particular distribution care

| Component | Upstream license / source |
| --- | --- |
| libvips binaries used by Sharp | LGPL-3.0-or-later; [source and license](https://github.com/libvips/libvips), [prebuilt binary sources and build scripts](https://github.com/lovell/sharp-libvips) |
| Lightning CSS | MPL-2.0; [source and license](https://github.com/parcel-bundler/lightningcss) |
| axe-core (development accessibility tooling) | MPL-2.0; [source and license](https://github.com/dequelabs/axe-core) |
| DOMPurify (used by Monaco) | Apache-2.0 OR MPL-2.0; [source and licenses](https://github.com/cure53/DOMPurify) |
| caniuse-lite data | CC-BY-4.0; [source and attribution](https://github.com/browserslist/caniuse-lite) |

This table is a guide, not an exhaustive dependency inventory. Binary/container
publishers must review the exact shipped artifact, preserve license and notice
files, and satisfy the relevant source-distribution requirements. An upstream
project link alone is not a substitute for providing required corresponding
source. Datool's Dockerfile retains dependency directories and their license
files; review any later pruning or standalone packaging changes accordingly.

## Source provenance and assets

Datool source copyright attribution is retained in `NOTICE`.

Google, Stripe, JavaScript, and other third-party names and logos identify the
integrations or technologies they represent. They remain the property of their
owners; Datool does not grant trademark rights or imply endorsement.
The Vite starter logo is distributed under Vite's MIT license.

The documentation screenshots use synthetic tutorial data; their provenance is
recorded in [public/docs-assets/README.md](public/docs-assets/README.md).

## GitHub Octicons mark

The GitHub mark in `components/cms/marketing-navigation.tsx` comes from
[GitHub Octicons](https://github.com/primer/octicons/blob/main/icons/mark-github-16.svg).
Its upstream MIT license is reproduced below. GitHub retains its trademark rights.

```text
MIT License

Copyright (c) 2026 GitHub Inc.

Permission is hereby granted, free of charge, to any person obtaining a copy
of this software and associated documentation files (the "Software"), to deal
in the Software without restriction, including without limitation the rights
to use, copy, modify, merge, publish, distribute, sublicense, and/or sell
copies of the Software, and to permit persons to whom the Software is
furnished to do so, subject to the following conditions:

The above copyright notice and this permission notice shall be included in all
copies or substantial portions of the Software.

THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS OR
IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF MERCHANTABILITY,
FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT. IN NO EVENT SHALL THE
AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER
LIABILITY, WHETHER IN AN ACTION OF CONTRACT, TORT OR OTHERWISE, ARISING FROM,
OUT OF OR IN CONNECTION WITH THE SOFTWARE OR THE USE OR OTHER DEALINGS IN THE
SOFTWARE.
```

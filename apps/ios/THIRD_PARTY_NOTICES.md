# Third-party notices

## Forked source

`YachiyoChatUI/Sources/YachiyoChatUI` contains the message list, message row, and chat input
view layer forked from [Lakr233/LanguageModelChatUI](https://github.com/Lakr233/LanguageModelChatUI)
at commit `e7bfb39f42804e1fd8b6fb22fa64ee987f5a9fa4` (tag 0.2.0). The fork removes the local
inference session and client kit, replaces SnapKit, GlyphixTextFx, and
AlignedCollectionViewFlowLayout with UIKit equivalents, and is driven by the remote thread store.

```
MIT License

Copyright (c) 2026 @Lakr233

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

## Swift packages

| Package | Version | License |
| --- | --- | --- |
| [Lakr233/MarkdownView](https://github.com/Lakr233/MarkdownView) | 3.9.1 | MIT |
| [Lakr233/ListViewKit](https://github.com/Lakr233/ListViewKit) | 1.2.0 | MIT |
| [Lakr233/Litext](https://github.com/Lakr233/Litext) | 1.3.0 | MIT |
| [apple/swift-collections](https://github.com/apple/swift-collections) | 1.6.0 | Apache-2.0 |

Transitive dependencies resolved by Swift Package Manager keep their own license files.

## Icons

`YachiyoRemote/Resources/Assets.xcassets/Lucide` is generated from
[lucide-static](https://lucide.dev) 1.47.0 (ISC License, Copyright (c) Lucide Contributors).

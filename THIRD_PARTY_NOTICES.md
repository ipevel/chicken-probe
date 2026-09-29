# 第三方组件与许可证

本主题在**发布包（`build/theme.tar.gz` / `dist/`）**里分发了第三方代码，
因此必须随附它们的许可证与版权声明。MIT 的条件很明确：再分发时要保留
版权声明与许可全文（"The above copyright notice and this permission notice
shall be included in all copies or substantial portions of the Software."），
而此前 `dist/vendor/` 只拷了 JS 本体、没有带任何声明。

## 打进发布包的组件

### three.js

- 版本：0.180.0
- 许可证：MIT
- 版权：Copyright © 2010-2025 three.js authors
- 仓库：https://github.com/mrdoob/three.js
- 在本项目中的位置：`vendor/three.module.js`、`vendor/three.core.js`
  （由 `tools/build-theme.mjs` 从 `node_modules/three/build/` 复制，
  仓库里不存第三方库副本）
- 用途：鸡场（3D 鸡窝）的渲染

许可证全文：

```
The MIT License

Copyright © 2010-2025 three.js authors

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

## 只在服务端使用、不随主题分发的组件

这些是 `dependencies` 里的运行时依赖，装在服务器上、**不进入主题包**。
列在这里是为了完整，不构成再分发。

### ws

- 版本：8.21.3
- 许可证：MIT
- 版权：Copyright (c) 2011 Einar Otto Stangvik；Copyright (c) 2013 Arnout
  Kazemier and contributors；Copyright (c) 2016 Luigi Pinca and contributors
- 仓库：https://github.com/websockets/ws
- 用途：联机服务（`server/`）的 WebSocket 实现

## 字体、图标与其他素材

本主题不使用任何第三方字体文件或图标库：

- 图标为内联 SVG（`theme/js/flag.js` 中的国旗）与本项目自绘路径
- 字体走系统栈（`ui-monospace` / `SFMono-Regular` / `Menlo` / `Consolas` /
  `system-ui`），不下载也不内嵌任何字体文件
- 无图片素材；`theme/index.html` 的站点图标是内联的 data: URI 表情符号

## 维护约定

依赖升级后，本文件里对应的版本号与版权年份必须一起更新。
`tools/build-theme.mjs` 会把本文件拷进发布包的根目录；
新增第三方依赖时，除了写进这里，也要确认它是否真的被打进了发布包——
只有进包的组件才需要附许可证。

# にゃんOverlay が同梱している第三者ソフトウェア

このフォルダのファイルは、AIによる背景切り抜きのために同梱しているものです。
いずれも商用利用が許可されたライセンスのものを選定しています。

---

## U^2-Net (u2netp.onnx)

- 配布元: https://github.com/xuebinqin/U-2-Net
- モデルファイルの取得元: https://github.com/danielgatis/rembg (v0.0.0 リリース)
- ライセンス: **Apache License 2.0**（商用利用可）
- 改変の有無: **なし**（配布されている u2netp.onnx をそのまま同梱）

論文:

    Qin, X., Zhang, Z., Huang, C., Dehghan, M., Zaiane, O., & Jagersand, M.
    "U^2-Net: Going Deeper with Nested U-Structure for Salient Object Detection."
    Pattern Recognition, 106, 107404 (2020).

Apache License 2.0 の全文: https://www.apache.org/licenses/LICENSE-2.0

    Copyright 2020 Xuebin Qin

    Licensed under the Apache License, Version 2.0 (the "License");
    you may not use this file except in compliance with the License.
    You may obtain a copy of the License at

        http://www.apache.org/licenses/LICENSE-2.0

    Unless required by applicable law or agreed to in writing, software
    distributed under the License is distributed on an "AS IS" BASIS,
    WITHOUT WARRANTIES OR CONDITIONS OF ANY KIND, either express or implied.
    See the License for the specific language governing permissions and
    limitations under the License.

注意: 同じ U^2-Net でも `u2net_portrait` は学習データ（APDrawing）が非商用限定の
ため使用していません。商用利用が許可されているのは `u2netp` / `u2net` です。

---

## ONNX Runtime Web (ort.wasm.min.js, ort-wasm-simd-threaded.wasm, ort-wasm-simd-threaded.mjs)

- 配布元: https://github.com/microsoft/onnxruntime
- バージョン: 1.20.1（npm パッケージ onnxruntime-web の dist をそのまま同梱）
- ライセンス: **MIT License**（商用利用可）
- 改変の有無: **なし**

    MIT License

    Copyright (c) Microsoft Corporation. All rights reserved.

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

---

## 採用しなかったモデル（記録）

- **RMBG-1.4 / RMBG-2.0 (BRIA AI)**: 精度は高いが、ライセンスが
  **非商用限定**。にゃんOverlay は広告を掲載しており商用利用にあたるため
  使用不可（利用には BRIA との有償契約が必要）。

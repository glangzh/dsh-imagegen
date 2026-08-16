# dsh-imagegen

dsh 插件,为 agent 补上图像能力(主模型本身不能看图、不会生图):

- **`imagegen`** — 让 agent 能生成、编辑、合成图片,并把结果保存为工作区文件
- **`image_understand`** — 让 agent 能"看懂"图片:把图片转成文字描述,主模型据此回答你的问题(看图说话、读图中文字、风格分析、多图对比、生成后自检)
- 安装即**全局生效**,所有会话/预设可用,无需改预设
- 配置全在「设置 → 插件 → 图像生成」,API Key 存本机凭据,明文不泄露
- **provider 无关**:默认接入 Agnes AI(OpenAI 兼容),换服务商只改设置,不改代码

## 安装

```sh
dsh plugin --profile web add github:glangzh/dsh-imagegen
```

重启 dsh web 后生效。

## 配置

打开「设置 → 插件 → 图像生成」:

| 项 | 说明 |
|---|---|
| **API Key** | 必填。填入 `sk-...` 保存;已配置时显示 `*` 掩码(长度与真实 key 一致,明文不回显) |
| **Base URL** | 默认 `https://api.agnes-ai.cn`(可带 `/v1`);换国际站填 `https://apihub.agnes-ai.com` |
| **生图模型** | 默认 `agnes-image-2.1-flash` |
| **视觉模型** | 默认 `agnes-2.5-flash` |

保存立即生效,无需重启。换服务商:改 Base URL 与模型即可。

## 使用

在会话里直接对 agent 说:

**生成**

> 生成一张赛博朋克风格的城市夜景图,16:9
> 画一张产品图:玻璃立方体放在白色桌上,摄影棚灯光,高细节

**图生图 / 编辑**

> 把 `docs/design.png` 改成水彩风格,保留构图不变
> 把 `照片.png` 的背景换成海边日落

**多图合成**

> 把 `a.png` 和 `b.png` 合成一张:两个角色背靠背站在黄昏的山顶

**识图**

> 看看 `截图.png` 里写了什么文字
> 这张图是什么风格?帮我分析构图和配色
> 对比一下 `a.png` 和 `b.png`,哪张构图更协调

**生成后校验**

> 生成一张「红苹果放在木桌上」的静物图,然后检查效果是否符合描述

生成结果保存在会话工作区 `generated_images/`,agent 会返回本地路径和远程 URL。

## 卸载

```sh
dsh plugin --profile web remove dsh-imagegen
```

## 许可

MIT

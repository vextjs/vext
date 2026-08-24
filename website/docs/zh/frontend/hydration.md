# Hydration

## 结论摘要

Hydration 默认启用。`hydration: "none"` 仍会正常返回完整的 SSR HTML、CSS 和 SEO；它不会返回空页面，也不会关闭 SSR。

它只阻止浏览器加载 Vext/React runtime。因此 React 事件、Vext Form、Vext fetcher 和框架管理的客户端导航不可用；原生 HTML 能力仍按浏览器行为工作。

## 默认 hydration 是什么

Hydration 会把浏览器端 React tree 接到 SSR 产出的 HTML 上。默认模式会加载 Vext browser entry，并将浏览器端 React tree 接到已经显示的页面上，让 Vext 的交互和客户端导航生效。

Vext 会把 render payload 写入 document，让 client entry 不需要重复执行首屏 service 调用：

- page id
- props
- layoutData
- locale 和 messages
- 初始 route 使用的 head metadata
- build id 和 route assets

## 默认模式与 `hydration: "none"` 的对比

| 项目               | 默认 hydration                                       | `hydration: "none"`                                             |
| ------------------ | ---------------------------------------------------- | --------------------------------------------------------------- |
| 首次页面加载       | SSR document 显示后加载浏览器 runtime 并 hydration。 | 完整 SSR document 正常显示；不加载 Vext/React browser runtime。 |
| SSR HTML           | 返回。                                               | 仍返回完整页面 HTML。                                           |
| CSS                | 返回并加载。                                         | 仍返回并加载。                                                  |
| SEO                | SSR metadata 可用。                                  | SSR metadata 仍可用。                                           |
| React 事件         | hydration 后可用。                                   | 不可用；`onClick` 等事件不会执行。                              |
| Vext Form          | 可用。                                               | 不可用。                                                        |
| Vext fetcher       | 可用。                                               | 不可用。                                                        |
| Vext 客户端导航    | 可用。                                               | 不可用；需要完整 document navigation。                          |
| 普通链接           | 可用。                                               | 仍可用，浏览器会执行普通 document navigation。                  |
| 普通 HTML 表单     | 可用。                                               | 仍可用，浏览器会执行普通表单提交。                              |
| Vext browser entry | 输出并加载。                                         | 不输出。                                                        |
| `__VEXT_DATA__`    | 输出供 client entry 复用。                           | 不输出。                                                        |
| route JS preload   | 输出 route JS 的 preload。                           | 不输出 route JS preload。                                       |

## 适合与不适合使用

### 适合使用

- 文章详情页。
- 文档页。
- 营销页。
- SEO 内容页。
- 只需要服务端输出的页面。
- 交互由应用自己加载的独立 script 处理的页面。

### 不适合使用

- 后台管理页面。
- 富文本编辑器。
- 搜索、筛选、分页等 React 交互页面。
- 使用 Vext Form 或 fetcher 的页面。
- 依赖 Vext 客户端导航的页面。

## 为一个 SSR 页面关闭 hydration

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

这个路由的行为如下：

- 首次访问仍会返回完整 SSR HTML。
- 页面可以正常显示并加载 CSS。
- 普通 `<a>` 链接和普通 HTML `<form>` 仍然可用。
- React `onClick` 等事件不会执行。
- Vext Form、fetcher 和框架管理的同 document 导航不会执行。
- 从 `none` 页面进入 hydration 页面时，需要完整 document navigation；进入目标页面后，hydration 会恢复。

用户自己写入 document 的独立 script 也会保留；是否工作取决于脚本自身，不依赖 Vext runtime。

## 关闭后失去的能力

`hydration: "none"` 页面中没有 Vext/React browser runtime，因此不能依赖框架接管页面后的行为：

- React 事件处理和依赖 React state 的交互不会运行。
- Vext Form 不会接管或增强表单。
- Vext fetcher 不会发起框架管理的客户端请求。
- Vext 不会管理同 document 客户端导航。

如果页面仍需要交互，请保留默认 hydration，或让页面使用与 Vext runtime 无关、由你自己加载和维护的独立 script。

## 整页作用范围和当前限制

`hydration: "none"` 作用于整个 document，不能只关闭某个 React 组件的 hydration。当前不能只 hydrate 搜索框、评论区或其他局部区域。

当前公开能力也不宣称支持 Selective/Partial Hydration、Islands、React Server Components 或 Partial Prerendering（PPR）。不要把这个路由级开关理解为局部 hydration 机制。

## 为什么当前没有全局配置

当前公开 API 没有全局 `hydration: "none"` 配置。同一个应用可以同时包含需要交互的页面和纯 SSR 页面；如果全局关闭，所有页面都会失去 React/Vext 客户端能力。

如果整个站点都需要纯 SSR，请逐个路由声明 `hydration: "none"`，或在应用自己的路由注册层统一生成这些路由配置。后者是应用层封装，不等于 Vext 提供了全局配置 API。

## Route options 的静态语法

Vext 会在构建阶段读取每个路由的 hydration policy，并据此生成 route manifest 和资源清单。直接内联声明是最简单的受支持形式：

```ts
app.get("/article/:slug", { frontend: { hydration: "none" } }, handler);
```

有限静态语法也接受同文件 `const` 对象、TypeScript 静态包装，以及第一参数可投影的 helper 调用。索引不会执行 helper 函数体、导入值、计算表达式或带插值的模板字符串；无法投影的 path 或被索引 schema 会携带 route 上下文失败，而不是静默遗漏。依赖请求数据的动态页面元数据继续放在 `res.render(..., { seo })`。

## 避免 Mismatch

保持 SSR 与浏览器输出确定：

| 风险                           | 更好的做法                                  |
| ------------------------------ | ------------------------------------------- |
| render 中直接使用 `Date.now()` | 在 route handler 中传入时间。               |
| 组件 render 中生成随机 id      | 在 render 前生成稳定 id，或放到 effect 中。 |
| SSR 阶段访问浏览器 API         | 放到 effect 或 client-only 分支。           |
| locale 对象结构不同            | 每个 locale 文件都与默认 locale 对齐。      |

## Hydration 标记

Vext 提供低噪音诊断标记：

```text
data-vext-hydration="hydrating"
data-vext-hydration="done"
performance.measure("vext:hydration")
```

`hydration: "none"` 的 document 会标记为 `data-vext-hydration="none"`，以便诊断该页面是有意不加载 browser runtime。生产环境不需要默认输出 console 性能日志；验证脚本读取 DOM 与 Performance API。

## Route Assets

Render manifest 会记录每个 route 的 initial JS/CSS。默认 hydration 的 SSR 可以注入 route-specific `modulepreload`，避免 hydration 后才发现 page chunk；`hydration: "none"` 不输出这些 route JS preload，但不会移除 CSS。

如果生产 `vext start` 发现 manifest 过旧且缺少 route assets，会 fail fast 并提示重新构建。

## 验证

修改本仓库文档后，运行文档契约检查：

```bash
npm run verify:docs-contract
```

这个命令只检查仓库文档契约，不是浏览器 runtime 测试。验证应用行为时，请使用应用自己的 build、start 和浏览器测试流程，并参照 [Hydration 验证](./hydration-validation)。

默认 hydration route 应出现 browser entry、route JS preload、`data-vext-hydration="done"` 和 `vext:hydration` Performance entry。`none` route 应保留 SSR HTML/CSS/SEO 并出现 `data-vext-hydration="none"`，但不应出现 Vext browser entry、`__VEXT_DATA__`、route JS preload、`done` marker 或 hydration Performance entry。

<!-- 仅供维护者的契约说明：E:\Worker\vextjs-test 是与当前机器绑定的本地配套项目，不是公开 Vext 命令或供读者复制的路径。 -->

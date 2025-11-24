// ==UserScript==
// @name         Gemini Anchor - 记忆锚点（书签）
// @namespace    http://tampermonkey.net/
// @version      8.0
// @description  Gemini 多标签书签系统。Alt+右键添加，悬浮自动展开，支持编辑/删除，不同对话独立存储(LocalStorage)。
// @author       Cishoon
// @match        https://gemini.google.com/*
// @icon         https://www.google.com/s2/favicons?sz=64&domain=google.com
// @grant        none
// ==/UserScript==

(function() {
    'use strict';

    console.log("Gemini Anchor v8: 记忆锚点版启动");

    // --- 配置 ---
    const CONFIG = {
        storageKeyPrefix: 'gemini_anchor_v8_',
        fabTop: '80px',
        fabRight: '20px',
        highlightColor: 'rgba(255, 214, 0, 0.3)', // 高亮颜色
        font: '"Google Sans", Roboto, sans-serif'
    };

    // --- 状态管理 ---
    // 结构: { id: timestamp, text: "preview...", domRef: Element(nullable), customLabel: "My Label" }
    let anchors = [];
    let fabContainer = null;
    let listContainer = null;

    // 获取当前对话的唯一ID (URL Path)
    const getChatId = () => window.location.pathname;

    // --- 1. 数据持久化 (LocalStorage) ---

    function loadAnchors() {
        const key = CONFIG.storageKeyPrefix + getChatId();
        const saved = localStorage.getItem(key);
        if (saved) {
            try {
                // 加载数据，但此时 domRef 都是空的，因为页面刷新了
                const parsed = JSON.parse(saved);
                // 过滤掉格式不对的数据
                anchors = parsed.map(item => ({
                    ...item,
                    domRef: null // 重置 DOM 引用，稍后懒加载查找
                }));
            } catch (e) {
                console.error("Load anchors failed", e);
                anchors = [];
            }
        } else {
            anchors = [];
        }
        renderList();
    }

    function saveAnchors() {
        const key = CONFIG.storageKeyPrefix + getChatId();
        // 保存时去掉 domRef，因为 DOM 对象不能被序列化
        const toSave = anchors.map(item => ({
            id: item.id,
            text: item.text,
            customLabel: item.customLabel
        }));
        localStorage.setItem(key, JSON.stringify(toSave));
        renderList();
    }

    // --- 2. 辅助函数：DOM 操作 ---

    // 尝试在页面中根据文本重新找回元素 (用于刷新后)
    function findElementByText(text) {
        // 这是一个简单的查找，它查找包含这段文字的最小节点
        // 针对 Gemini 的结构，我们优先查找 p, li, pre, code, span
        const xpath = `//*[contains(text(), "${text.substring(0, 20).replace(/"/g, '')}")]`; // 取前20个字匹配
        const iterator = document.evaluate(xpath, document.body, null, XPathResult.ANY_TYPE, null);
        let node = iterator.iterateNext();

        // 只要找到一个大致匹配的就行。Gemini 对话通常不会有完全重复的长句。
        // 如果找到的是文本节点，取其父级
        if (node && node.nodeType === 3) return node.parentNode;
        return node;
    }

    // 安全创建 SVG
    function createSvgIcon(pathData, size = "16", color = "currentColor") {
        const svg = document.createElementNS("http://www.w3.org/2000/svg", "svg");
        svg.setAttribute("viewBox", "0 0 24 24");
        svg.setAttribute("width", size);
        svg.setAttribute("height", size);
        svg.style.fill = color;
        svg.style.display = "block";
        svg.style.flexShrink = "0";
        const path = document.createElementNS("http://www.w3.org/2000/svg", "path");
        path.setAttribute("d", pathData);
        svg.appendChild(path);
        return svg;
    }

    const PATHS = {
        target: "M12 8c-2.21 0-4 1.79-4 4s1.79 4 4 4 4-1.79 4-4-1.79-4-4-4zm8.94 3c-.46-4.17-3.77-7.48-7.94-7.94V1h-2v2.06C6.83 3.52 3.52 6.83 3.06 11H1v2h2.06c.46 4.17 3.77 7.48 7.94 7.94V23h2v-2.06c4.17-.46 7.48-3.77 7.94-7.94H23v-2h-2.06zM12 19c-3.87 0-7-3.13-7-7s3.13-7 7-7 7 3.13 7-7 7z",
        edit: "M3 17.25V21h3.75L17.81 9.94l-3.75-3.75L3 17.25zM20.71 7.04c.39-.39.39-1.02 0-1.41l-2.34-2.34c-.39-.39-1.02-.39-1.41 0l-1.83 1.83 3.75 3.75 1.83-1.83z",
        delete: "M6 19c0 1.1.9 2 2 2h8c1.1 0 2-.9 2-2V7H6v12zM19 4h-3.5l-1-1h-5l-1 1H5v2h14V4z",
        list: "M3 13h2v-2H3v2zm0 4h2v-2H3v2zm0-8h2V7H3v2zm4 4h14v-2H7v2zm0 4h14v-2H7v2zM7 7v2h14V7H7z"
    };

    // --- 3. UI 构建 (原生DOM + 内联样式) ---

    function createUI() {
        if (document.getElementById('gemini-anchor-root')) return;

        // 根容器
        const root = document.createElement('div');
        root.id = 'gemini-anchor-root';
        Object.assign(root.style, {
            position: 'fixed',
            top: CONFIG.fabTop,
            right: CONFIG.fabRight,
            zIndex: '2147483647',
            fontFamily: CONFIG.font,
            display: 'flex',
            flexDirection: 'column', // 垂直排列：按钮在下，列表在上，或者反过来
            alignItems: 'flex-end',  // 靠右对齐
            pointerEvents: 'none'    // 容器本身不阻挡点击，子元素阻挡
        });

        // 1. 列表容器 (默认隐藏)
        const list = document.createElement('div');
        Object.assign(list.style, {
            background: 'rgba(255, 255, 255, 0.95)',
            backdropFilter: 'blur(10px)',
            borderRadius: '12px',
            boxShadow: '0 4px 24px rgba(0,0,0,0.15)',
            border: '1px solid rgba(0,0,0,0.05)',
            width: '260px',
            maxHeight: '0px', // 初始高度为0
            overflow: 'hidden',
            transition: 'all 0.3s cubic-bezier(0.4, 0, 0.2, 1)',
            marginTop: '8px',
            opacity: '0',
            pointerEvents: 'auto',
            display: 'flex',
            flexDirection: 'column'
        });

        // 暗黑适配
        if (window.matchMedia('(prefers-color-scheme: dark)').matches) {
            list.style.background = 'rgba(32, 33, 36, 0.95)';
            list.style.border = '1px solid rgba(255,255,255,0.1)';
            list.style.color = '#e8eaed';
        }

        // 2. 主按钮 (FAB)
        const fab = document.createElement('div');
        Object.assign(fab.style, {
            width: '40px',
            height: '40px',
            background: '#fff',
            borderRadius: '50%',
            boxShadow: '0 2px 10px rgba(0,0,0,0.2)',
            display: 'flex',
            alignItems: 'center',
            justifyContent: 'center',
            cursor: 'pointer',
            pointerEvents: 'auto',
            border: '1px solid #dadce0',
            transition: 'transform 0.2s',
            marginTop: '0px' // 贴顶
        });

        if (window.matchMedia('(prefers-color-scheme: dark)').matches) {
            fab.style.background = '#303134';
            fab.style.border = '1px solid #5f6368';
        }

        // 主按钮图标 (列表图标)
        fab.appendChild(createSvgIcon(PATHS.list, "22", window.matchMedia('(prefers-color-scheme: dark)').matches ? "#e8eaed" : "#5f6368"));

        // --- 事件交互 ---

        // 鼠标移入整个区域 (Root) 显示列表
        // 为了体验更好，我们在 Root 上绑定 hover，这样鼠标在列表和按钮之间移动不会断开
        const hoverArea = document.createElement('div');
        Object.assign(hoverArea.style, {
            display: 'flex',
            flexDirection: 'column',
            alignItems: 'flex-end',
            pointerEvents: 'auto'
        });

        hoverArea.addEventListener('mouseenter', () => {
            if (anchors.length === 0) return; // 没数据不展开
            list.style.maxHeight = '400px'; // 展开高度
            list.style.opacity = '1';
            list.style.padding = '8px 0'; // 增加内边距
        });

        hoverArea.addEventListener('mouseleave', () => {
            list.style.maxHeight = '0px';
            list.style.opacity = '0';
            list.style.padding = '0';
        });

        hoverArea.appendChild(fab);
        hoverArea.appendChild(list);
        root.appendChild(hoverArea);

        document.documentElement.appendChild(root);

        fabContainer = fab;
        listContainer = list;
    }

    // --- 4. 渲染列表 ---

    function renderList() {
        if (!listContainer) return;

        // 清空列表 (Safe method)
        while (listContainer.firstChild) {
            listContainer.removeChild(listContainer.firstChild);
        }

        if (anchors.length === 0) {
            // 空状态
            const empty = document.createElement('div');
            empty.textContent = "Alt + 右键添加书签";
            Object.assign(empty.style, {
                padding: '12px 16px',
                fontSize: '13px',
                color: '#9aa0a6',
                textAlign: 'center'
            });
            listContainer.appendChild(empty);
            return;
        }

        // 滚动容器
        const scrollBox = document.createElement('div');
        Object.assign(scrollBox.style, {
            overflowY: 'auto',
            maxHeight: '380px'
        });

        anchors.forEach((item, index) => {
            const row = document.createElement('div');
            Object.assign(row.style, {
                display: 'flex',
                alignItems: 'center',
                padding: '8px 12px',
                cursor: 'pointer',
                transition: 'background 0.1s',
                borderBottom: '1px solid rgba(0,0,0,0.03)'
            });

            row.addEventListener('mouseenter', () => row.style.background = 'rgba(0,0,0,0.04)');
            row.addEventListener('mouseleave', () => row.style.background = 'transparent');
            if (window.matchMedia('(prefers-color-scheme: dark)').matches) {
                row.addEventListener('mouseenter', () => row.style.background = 'rgba(255,255,255,0.08)');
            }

            // 1. 序号徽章
            const badge = document.createElement('span');
            badge.textContent = index + 1;
            Object.assign(badge.style, {
                fontSize: '10px',
                background: '#eee',
                color: '#666',
                padding: '2px 6px',
                borderRadius: '10px',
                marginRight: '8px',
                minWidth: '14px',
                textAlign: 'center'
            });
            if (window.matchMedia('(prefers-color-scheme: dark)').matches) {
                badge.style.background = '#444';
                badge.style.color = '#ccc';
            }

            // 2. 文本 (Label)
            const labelSpan = document.createElement('span');
            labelSpan.textContent = item.customLabel || item.text.substring(0, 15) + (item.text.length > 15 ? '...' : '');
            labelSpan.title = item.text; // Tooltip显示全文
            Object.assign(labelSpan.style, {
                flex: '1',
                fontSize: '13px',
                whiteSpace: 'nowrap',
                overflow: 'hidden',
                textOverflow: 'ellipsis',
                marginRight: '8px',
                fontWeight: '500'
            });

            // 3. 按钮组
            const btnGroup = document.createElement('div');
            Object.assign(btnGroup.style, { display: 'flex', gap: '4px' });

            // 编辑按钮
            const editBtn = document.createElement('div');
            editBtn.appendChild(createSvgIcon(PATHS.edit, "14", "#80868b"));
            Object.assign(editBtn.style, { padding: '4px', borderRadius: '4px' });
            editBtn.addEventListener('mouseenter', () => editBtn.style.background = 'rgba(0,0,0,0.1)');
            editBtn.addEventListener('mouseleave', () => editBtn.style.background = 'transparent');
            editBtn.addEventListener('click', (e) => {
                e.stopPropagation();
                const newName = prompt("编辑书签名称:", item.customLabel || item.text);
                if (newName !== null) {
                    anchors[index].customLabel = newName;
                    saveAnchors();
                }
            });

            // 删除按钮
            const delBtn = document.createElement('div');
            delBtn.appendChild(createSvgIcon(PATHS.delete, "14", "#d93025"));
            Object.assign(delBtn.style, { padding: '4px', borderRadius: '4px' });
            delBtn.addEventListener('mouseenter', () => delBtn.style.background = 'rgba(217, 48, 37, 0.1)');
            delBtn.addEventListener('mouseleave', () => delBtn.style.background = 'transparent');
            delBtn.addEventListener('click', (e) => {
                e.stopPropagation();
                anchors.splice(index, 1);
                saveAnchors();
            });

            btnGroup.appendChild(editBtn);
            btnGroup.appendChild(delBtn);

            // --- 点击跳转逻辑 ---
            row.addEventListener('click', () => {
                let target = item.domRef;

                // 如果内存里没有（比如刷新过），尝试重新查找
                if (!target || !document.body.contains(target)) {
                    console.log("DOM 丢失，尝试通过文本重新搜索:", item.text);
                    const found = findElementByText(item.text);
                    if (found) {
                        target = found;
                        // 更新引用，下次不用再找
                        anchors[index].domRef = target;
                    } else {
                        alert("无法定位该书签 (可能是页面内容未加载，请向上滚动加载更多历史记录后重试)。");
                        return;
                    }
                }

                target.scrollIntoView({ behavior: 'smooth', block: 'center' });

                // 高亮动画
                const originalBg = target.style.backgroundColor;
                const originalTrans = target.style.transition;
                target.style.transition = "background-color 0.5s ease";
                target.style.backgroundColor = CONFIG.highlightColor;
                setTimeout(() => {
                    target.style.backgroundColor = originalBg;
                    setTimeout(() => target.style.transition = originalTrans, 500);
                }, 1500);
            });

            row.appendChild(badge);
            row.appendChild(labelSpan);
            row.appendChild(btnGroup);
            scrollBox.appendChild(row);
        });

        listContainer.appendChild(scrollBox);
    }

    // --- 5. 核心：添加书签逻辑 ---

    function initContextMenu() {
        document.addEventListener('contextmenu', function(e) {
            if (!e.altKey) return; // 必须按住 Alt

            e.preventDefault();
            e.stopPropagation();

            let target = e.target;
            // 简单清洗文本
            const rawText = target.innerText || target.textContent || "";
            const cleanText = rawText.replace(/\s+/g, ' ').trim();

            if (!cleanText) {
                alert("此处没有可标记的文本。");
                return;
            }

            // 添加到数据
            const newAnchor = {
                id: Date.now(),
                text: cleanText, // 保存原文用于索引
                customLabel: "", // 默认无自定义名
                domRef: target
            };

            anchors.push(newAnchor);
            saveAnchors(); // 保存到 LS 并重绘列表

            // 视觉反馈 (波纹)
            showClickRipple(e.clientX, e.clientY);

            // 自动展开一下列表提示用户
            if (listContainer) {
                 // 临时模拟 hover 效果
                 listContainer.style.maxHeight = '400px';
                 listContainer.style.opacity = '1';
                 listContainer.style.padding = '8px 0';
                 setTimeout(() => {
                     // 如果鼠标没在上面，就收回去
                     if (!fabContainer.matches(':hover') && !listContainer.matches(':hover')) {
                         listContainer.style.maxHeight = '0px';
                         listContainer.style.opacity = '0';
                         listContainer.style.padding = '0';
                     }
                 }, 1500);
            }
        }, true);
    }

    // 点击反馈波纹
    function showClickRipple(x, y) {
        const ripple = document.createElement('div');
        Object.assign(ripple.style, {
            position: 'fixed',
            left: (x - 20) + 'px',
            top: (y - 20) + 'px',
            width: '40px',
            height: '40px',
            borderRadius: '50%',
            border: '2px solid #1a73e8',
            backgroundColor: 'rgba(26, 115, 232, 0.2)',
            zIndex: '2147483647',
            pointerEvents: 'none',
            transform: 'scale(0.5)',
            opacity: '1',
            transition: 'all 0.4s ease-out'
        });
        document.body.appendChild(ripple);
        requestAnimationFrame(() => {
            ripple.style.transform = 'scale(1.5)';
            ripple.style.opacity = '0';
        });
        setTimeout(() => ripple.remove(), 500);
    }

    // --- 6. 路由变化监听 (SPA) ---
    // Gemini 切换对话时页面不刷新，需要手动重新加载对应的书签
    function initRouterListener() {
        let lastPath = location.pathname;
        const checkUrl = () => {
            if (location.pathname !== lastPath) {
                lastPath = location.pathname;
                console.log("对话切换，加载新书签...");
                loadAnchors();
            }
        };
        // 监听点击和历史记录变化
        window.addEventListener('popstate', checkUrl);
        document.addEventListener('click', () => setTimeout(checkUrl, 500)); // 粗暴但有效的监听点击链接
        setInterval(checkUrl, 2000); // 兜底
    }

    // --- 7. 启动 ---
    function init() {
        createUI();
        loadAnchors();
        initContextMenu();
        initRouterListener();
    }

    if (document.readyState === 'loading') {
        document.addEventListener('DOMContentLoaded', init);
    } else {
        init();
    }

})();

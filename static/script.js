document.addEventListener('DOMContentLoaded', () => {
  // --- 初期化 ---
  mermaid.initialize({ startOnLoad: false, theme: 'base' });
  firebase.initializeApp(firebaseConfig);
  const auth = firebase.auth();

  // --- グローバル状態管理 ---
  let state = {
    workflows: [], // {id, name} のリスト
    currentWorkflow: null, // {id, name, config, prompts, scripts, files}
    selectedPrompt: null,
  };
  
  // デバウンス関数：連続するイベントをまとめ、最後のイベントから指定時間後に関数を実行
  function debounce(func, wait) {
    let timeout;
    return function executedFunction(...args) {
      const later = () => {
        clearTimeout(timeout);
        func(...args);
      };
      clearTimeout(timeout);
      timeout = setTimeout(later, wait);
    };
  }

  // 2秒間操作がなければ saveWorkflow を実行するデバウンスされた関数
  const debouncedSave = debounce(() => saveWorkflow(), 2000);
  
  // 保存ステータスの表示を更新するヘルパー関数
  const statusElement = document.getElementById('save-status');
  function updateSaveStatus(status, color = 'var(--secondary-color)') {
    if (statusElement) {
      statusElement.textContent = status;
      statusElement.style.color = color;
    }
  }

  // 変更があったことをユーザーに通知し、自動保存を予約する関数
  function handleStateChange() {
    if (!state.currentWorkflow) return; // ワークフローがロードされていない場合は何もしない
    updateSaveStatus('変更あり（自動保存されます）');
    debouncedSave();
  }

  // --- UI要素 ---
  const authContainer = document.getElementById('auth-container');
  const appContainer = document.getElementById('app-container');
  const authError = document.getElementById('auth-error');
  const userEmail = document.getElementById('user-email');
  const workflowNameInput = document.getElementById('workflow-name-input');
  const nodesList = document.getElementById('nodes-list');
  const edgesList = document.getElementById('edges-list');
  const promptSelect = document.getElementById('prompt-select');
  const promptTextarea = document.getElementById('prompt-textarea');
  const entryPointSelect = document.getElementById('entry-point-select');
  const finalOutputKeyInput = document.getElementById('final-output-key-input');
  const graphContainer = document.getElementById('graph-container');
  const editorPanel = document.querySelector('.editor-panel');
  const saveStatus = document.getElementById('save-status');

  const workflowList = document.getElementById('workflow-list');
  const newWorkflowNameInput = document.getElementById('new-workflow-name-input');
  const addNewWorkflowBtn = document.getElementById('add-new-workflow-btn');

  // --- ファイル管理UI要素 ---
  const fileList = document.getElementById('file-list');
  const fileUploadInput = document.getElementById('file-upload-input');
  const fileOutputKeyInput = document.getElementById('file-output-key-input');
  const uploadFileBtn = document.getElementById('upload-file-btn');
  const fileError = document.getElementById('file-error');
  const fileUploadSpinner = document.getElementById('file-upload-spinner');
  // ZipオプションUI
  const zipOptions = document.getElementById('zip-options');
  const excludedExtensionsInput = document.getElementById('excluded-extensions-input');


  // --- 結果表示のタブ切り替え ---
  const resultsArea = document.getElementById('results-area');
  resultsArea.addEventListener('click', (e) => {
    if (e.target.classList.contains('tab-link')) {
      const tabId = e.target.dataset.tab;
      resultsArea.querySelectorAll('.tab-link').forEach(tab => tab.classList.remove('active'));
      resultsArea.querySelectorAll('.tab-content').forEach(content => content.classList.remove('active'));
      e.target.classList.add('active');
      document.getElementById(tabId).classList.add('active');
    }
  });

  // --- APIヘルパー ---
  async function fetchAPI(endpoint, options = {}) {
    const user = auth.currentUser;
    if (!user) throw new Error("Not authenticated");

    const token = await user.getIdToken();
    const headers = {
      'Authorization': `Bearer ${token}`,
      ...options.headers,
    };
    if (!(options.body instanceof FormData)) {
      headers['Content-Type'] = 'application/json';
    }

    const response = await fetch(endpoint, { ...options, headers });

    if (!response.ok) {
      const errorData = await response.json().catch(() => ({ error: 'API request failed' }));
      throw new Error(errorData.error || 'API request failed');
    }
    const contentType = response.headers.get("content-type");
    if (contentType && contentType.includes("application/json")) {
      return response.json();
    }
    return {};
  }

  // --- 認証ロジック ---
  auth.onAuthStateChanged(user => {
    if (user) {
      authContainer.style.display = 'none';
      appContainer.style.display = 'grid';
      userEmail.textContent = user.email;
      loadWorkflows();
    } else {
      authContainer.style.display = 'flex';
      appContainer.style.display = 'none';
      userEmail.textContent = '';
    }
  });

  document.getElementById('login-btn').addEventListener('click', () => {
    const email = document.getElementById('email-input').value;
    const password = document.getElementById('password-input').value;
    auth.signInWithEmailAndPassword(email, password)
      .catch(error => {
        authError.textContent = error.message;
        authError.style.display = 'block';
      });
  });

  document.getElementById('signup-btn').addEventListener('click', () => {
    const email = document.getElementById('email-input').value;
    const password = document.getElementById('password-input').value;
    auth.createUserWithEmailAndPassword(email, password)
      .catch(error => {
        authError.textContent = error.message;
        authError.style.display = 'block';
      });
  });

  document.getElementById('logout-btn').addEventListener('click', () => {
    auth.signOut();
  });

  // --- ワークフロー管理ロジック ---
  async function loadWorkflows() {
    try {
      state.workflows = await fetchAPI('/api/workflows');
      renderWorkflowList();
      if (state.workflows.length > 0) {
        const currentId = state.currentWorkflow ? state.currentWorkflow.id : null;
        const currentExists = state.workflows.some(w => w.id === currentId);
        const idToLoad = currentExists ? currentId : state.workflows[0].id;
        await loadWorkflowDetail(idToLoad);
      } else {
        showEmptyState();
      }
    } catch (error) {
      console.error("Failed to load workflows:", error);
      alert("ワークフローの読み込みに失敗しました。");
    }
  }

  function showEmptyState() {
    state.currentWorkflow = null;
    workflowList.innerHTML = '<li>ワークフローがありません</li>';
    editorPanel.style.display = 'none';
    graphContainer.innerHTML = '<p>左下のフォームから新しいワークフローを作成してください。</p>';
  }

  async function loadWorkflowDetail(workflowId) {
    if (!workflowId) {
      showEmptyState();
      return;
    }
    try {
      editorPanel.style.display = 'block';
      const workflowData = await fetchAPI(`/api/workflows/${workflowId}`);
      state.currentWorkflow = {
        ...workflowData,
        id: workflowId,
        files: workflowData.files || [], // filesプロパティを保証
      };
      state.selectedPrompt = null;
      renderAll();
      document.querySelectorAll('#workflow-list li').forEach(li => {
        li.classList.toggle('active', li.dataset.id === workflowId);
      });
      updateSaveStatus(''); // 新しいワークフローをロードしたら保存ステータスをリセット
    } catch (error) {
      console.error("Failed to load workflow detail:", error);
      alert("ワークフロー詳細の読み込みに失敗しました。");
      showEmptyState();
    }
  }

  addNewWorkflowBtn.addEventListener('click', async () => {
    const newName = newWorkflowNameInput.value.trim();
    if (!newName) {
      alert('ワークフロー名を入力してください。');
      newWorkflowNameInput.focus();
      return;
    }

    /* いつでも復活できるようにサンプルをコメントアウト
    const sampleWorkflowTemplate = {
      name: newName,
      config: {
        "entry_point": "start_node", "final_output_key": "final_report",
        "nodes": [
          { "id": "start_node", "type": "join", "output_key": "" }, { "id": "analyst_optimistic", "type": "llm", "output_key": "optimistic_view" }, { "id": "analyst_pessimistic", "type": "llm", "output_key": "pessimistic_view" }, { "id": "final_reporter", "type": "llm", "output_key": "final_report" }
        ],
        "edges": [
          { "source": "start_node", "target": "analyst_optimistic", "conditional": false }, { "source": "start_node", "target": "analyst_pessimistic", "conditional": false }, { "source": "analyst_optimistic", "target": "final_reporter", "conditional": false }, { "source": "analyst_pessimistic", "target": "final_reporter", "conditional": false }, { "source": "final_reporter", "target": "__end__", "conditional": false }
        ]
      },
      prompts: {
        "analyst_optimistic": "あなたは非常に楽観的なソフトウェアエンジニアです。\n提供されたソースコードについて、ポジティブな分析をしてください。\n\nソースコード:\n```\n{input}\n```\n\n分析結果:",
        "analyst_pessimistic": "あなたは非常に悲観的なソフトウェアレビューアです。\n提供されたソースコードについて、潜在的なリスクを指摘してください。\n\nソースコード:\n```\n{input}\n```\n\n分析結果:",
        "final_reporter": "あなたは優秀なプロジェクトリーダーです。\n以下の分析レポートを統合し、最終的な評価をまとめてください。\n\n# 楽観的分析:\n{optimistic_view}\n\n# 悲観的分析:\n{pessimistic_view}\n\n# 最終レポート:",
      },
      scripts: {},
      files: []
    };
    */

    // 新しい空のワークフローテンプレート
    const newWorkflowTemplate = {
      name: newName,
      config: {
        entry_point: "",
        final_output_key: "",
        nodes: [],
        edges: []
      },
      prompts: {},
      scripts: {},
      files: []
    };

    try {
      const result = await fetchAPI('/api/workflows', {
        method: 'POST',
        body: JSON.stringify(newWorkflowTemplate)
      });
      state.currentWorkflow = { ...newWorkflowTemplate, id: result.id };
      await loadWorkflows();
      newWorkflowNameInput.value = '';
    } catch (error) {
      console.error('Failed to create workflow:', error);
      alert(`ワークフローの作成に失敗しました: ${error.message}`);
    }
  });

  workflowList.addEventListener('click', async (e) => {
    const li = e.target.closest('li[data-id]');
    if (!li) return;
    const workflowId = li.dataset.id;
    const deleteBtn = e.target.closest('.delete-workflow-btn');

    if (deleteBtn) {
      e.stopPropagation();
      const workflowName = li.querySelector('span').textContent;
      if (!confirm(`ワークフロー「${workflowName}」を本当に削除しますか？\n関連するファイルも全て削除され、この操作は元に戻せません。`)) return;

      try {
        await fetchAPI(`/api/workflows/${workflowId}`, { method: 'DELETE' });
        if (state.currentWorkflow && state.currentWorkflow.id === workflowId) {
          state.currentWorkflow = null;
        }
        await loadWorkflows();
      } catch (error) {
        console.error("Failed to delete workflow:", error);
        alert(`削除に失敗しました: ${error.message}`);
      }
    } else {
      if (!state.currentWorkflow || state.currentWorkflow.id !== workflowId) {
        await loadWorkflowDetail(workflowId);
      }
    }
  });

  async function saveWorkflow() {
    if (!state.currentWorkflow || !state.currentWorkflow.id) {
      console.warn("保存するワークフローが選択されていません。");
      return;
    }

    // デバウンスによる自動保存が走る前に手動保存された場合、タイマーをキャンセル
    clearTimeout(debouncedSave);

    updateSaveStatus('保存中...', 'var(--secondary-color)');

    const oldName = state.workflows.find(w => w.id === state.currentWorkflow.id)?.name;
    const newName = workflowNameInput.value;
    state.currentWorkflow.name = newName;

    try {
      // ファイル情報は別APIで管理するため、ここでは送信しない
      const payload = {
        name: state.currentWorkflow.name,
        config: state.currentWorkflow.config,
        prompts: state.currentWorkflow.prompts,
        scripts: state.currentWorkflow.scripts,
      };
      await fetchAPI(`/api/workflows/${state.currentWorkflow.id}`, { method: 'PUT', body: JSON.stringify(payload) });

      updateSaveStatus('保存しました！', 'var(--success-color)');

      if (oldName !== newName) {
        const workflowInList = state.workflows.find(w => w.id === state.currentWorkflow.id);
        if (workflowInList) workflowInList.name = newName;
        renderWorkflowList();
        document.querySelector(`#workflow-list li[data-id="${state.currentWorkflow.id}"]`)?.classList.add('active');
      }
    } catch (error) {
      console.error(error);
      updateSaveStatus(`保存失敗: ${error.message}`, 'var(--danger-color)');
    }
    // 4秒後にステータスメッセージを消す
    setTimeout(() => {
      // 他の変更通知を妨げないように、現在のメッセージがエラーでない場合のみ消す
      if (saveStatus.style.color !== 'var(--danger-color)') {
        updateSaveStatus('');
      }
    }, 4000);
  }
  document.getElementById('save-workflow-btn').addEventListener('click', saveWorkflow);

  // --- 描画ロジック ---
  function renderAll() {
    if (!state.currentWorkflow) return;
    renderWorkflowName();
    renderFiles();
    renderNodes();
    renderEdges();
    renderGlobalSettings();
    renderEditor();
    updateNodeOptions();
    renderGraph();
  }

  function renderWorkflowList() {
    workflowList.innerHTML = '';
    if (state.workflows.length === 0) {
      workflowList.innerHTML = '<li>ワークフローがありません</li>';
      return;
    }
    state.workflows.forEach(w => {
      const li = document.createElement('li');
      li.dataset.id = w.id;
      li.innerHTML = `
        <span>${escapeHTML(w.name)}</span>
        <button class="delete-workflow-btn material-icons-outlined" title="削除">delete_outline</button>
      `;
      workflowList.appendChild(li);
    });
  }

  function renderFiles() {
    fileList.innerHTML = '';
    fileError.style.display = 'none';
    fileError.textContent = '';

    if (!state.currentWorkflow || !state.currentWorkflow.files || state.currentWorkflow.files.length === 0) {
      fileList.innerHTML = '<div class="file-list-item">ファイルがありません</div>';
      return;
    }

    state.currentWorkflow.files.forEach(file => {
      const item = document.createElement('div');
      item.className = 'file-list-item';

      let extraInfo = '';
      if (file.contentType?.includes('zip') && file.excludedExtensions && file.excludedExtensions.length > 0) {
        extraInfo = `<div class="file-extra-info">除外: ${escapeHTML(file.excludedExtensions.join(', '))}</div>`;
      }

      item.innerHTML = `
        <div class="file-list-item-info">
          <span class="material-icons-outlined">description</span>
          <div>
            <span>${escapeHTML(file.fileName)} &rarr; <code>${escapeHTML(file.outputKey)}</code></span>
            ${extraInfo}
          </div>
        </div>
        <button class="delete-file-btn material-icons-outlined" data-filename="${escapeHTML(file.fileName)}" title="ファイルを削除">
          delete
        </button>
      `;
      fileList.appendChild(item);
    });
  }

  function escapeHTML(str) {
    if (typeof str !== 'string') return '';
    const p = document.createElement("p");
    p.textContent = str;
    return p.innerHTML;
  }

  function renderWorkflowName() {
    workflowNameInput.value = state.currentWorkflow.name;
  }

  async function renderGraph() {
    if (!state.currentWorkflow || !state.currentWorkflow.config) return;
    const { config } = state.currentWorkflow;
    const graphDefinition = ['graph TD'];
    config.nodes.forEach(node => {
      const nodeId = node.id.replace(/"/g, '#quot;');
      let nodeLabel = `${node.id}<br/><i>(${node.type})</i>`;
      if (node.type === 'python') {
        graphDefinition.push(`  ${nodeId}["${nodeLabel}"]`);
        graphDefinition.push(`  style ${nodeId} fill:#fff0e6,stroke:#ff9933,stroke-width:2px`);
      } else if (node.type === 'join') {
        graphDefinition.push(`  ${nodeId}{"${nodeLabel}"}`);
      } else {
        graphDefinition.push(`  ${nodeId}["${nodeLabel}"]`);
      }
    });
    if (config.entry_point) {
      graphDefinition.push(`  style ${config.entry_point} fill:#e9f7ef,stroke:#27ae60,stroke-width:2px`);
    }
    config.edges.forEach(edge => {
      const source = edge.source.replace(/"/g, '#quot;');
      const target = edge.target.replace(/"/g, '#quot;');
      const arrow = edge.conditional ? '-- 条件分岐 -->' : '-->';
      graphDefinition.push(`  ${source} ${arrow} ${target}`);
    });
    if (config.nodes.length === 0) {
      graphContainer.innerHTML = '<p>ノードを追加してワークフローの作成を開始してください。</p>';
      return;
    }
    try {
      const { svg } = await mermaid.render('workflow-svg', graphDefinition.join('\n'));
      graphContainer.innerHTML = svg;
    } catch (error) {
      console.error('Mermaid render error:', error);
      graphContainer.innerHTML = '<p style="color:red;">グラフの描画に失敗しました。</p>';
    }
  }

  function renderNodes() {
    nodesList.innerHTML = '';
    state.currentWorkflow.config.nodes.forEach((node, index) => {
      const div = document.createElement('div');
      div.className = 'item-card';
      div.innerHTML = `
        <input type="text" value="${node.id}" class="node-id" data-index="${index}" placeholder="ノードID">
        <select class="node-type" data-index="${index}">
          <option value="llm" ${node.type === 'llm' ? 'selected' : ''}>LLM</option>
          <option value="python" ${node.type === 'python' ? 'selected' : ''}>Python</option>
          <option value="join" ${node.type === 'join' ? 'selected' : ''}>Join</option>
        </select>
        <input type="text" value="${node.output_key || ''}" class="node-output-key" data-index="${index}" placeholder="出力キー">
        <button class="delete-btn" data-index="${index}"><span class="material-icons-outlined">delete</span></button>
      `;
      nodesList.appendChild(div);
    });
  }

  function renderEdges() {
    edgesList.innerHTML = '';
    state.currentWorkflow.config.edges.forEach((edge, index) => {
      const div = document.createElement('div');
      div.className = 'item-card';
      div.innerHTML = `
        <div style="display:flex; flex-direction:column; gap: 5px; width: 100%; grid-column: 1 / 4;">
          <div style="display:flex; align-items:center; gap: 8px;">
            <select class="edge-source" data-index="${index}"></select>
            <span>&rarr;</span>
            <select class="edge-target" data-index="${index}"></select>
          </div>
          <label><input type="checkbox" class="edge-conditional" data-index="${index}" ${edge.conditional ? 'checked' : ''}> 条件分岐</label>
        </div>
        <button class="delete-btn" data-index="${index}" style="grid-column: 4;"><span class="material-icons-outlined">delete</span></button>
      `;
      edgesList.appendChild(div);
    });
  }

  function renderGlobalSettings() {
    finalOutputKeyInput.value = state.currentWorkflow.config.final_output_key || '';
  }

  function renderEditor() {
    const { config, prompts, scripts } = state.currentWorkflow;
    promptSelect.innerHTML = '';
    const editableNodes = config.nodes.filter(n => n.type === 'llm' || n.type === 'python');
    if (editableNodes.length === 0) {
      promptSelect.innerHTML = '<option>編集可能なノードがありません</option>';
      promptTextarea.value = '';
      promptTextarea.disabled = true;
      return;
    }
    promptTextarea.disabled = false;
    editableNodes.forEach(node => {
      const option = document.createElement('option');
      option.value = node.id;
      option.textContent = `${node.id} (${node.type})`;
      promptSelect.appendChild(option);
      if (node.type === 'llm' && prompts[node.id] === undefined) {
        prompts[node.id] = ``;
      } else if (node.type === 'python' && scripts[node.id] === undefined) {
        scripts[node.id] = `def main(state):\n\n  result = f"Hello from Python: {state.get('input', 'no input')}"\n\n  return result\n`;
      }
    });
    if (!state.selectedPrompt || !editableNodes.some(n => n.id === state.selectedPrompt)) {
      state.selectedPrompt = editableNodes.length > 0 ? editableNodes[0].id : null;
    }
    if (state.selectedPrompt) {
      promptSelect.value = state.selectedPrompt;
      const selectedNode = editableNodes.find(n => n.id === state.selectedPrompt);
      if (selectedNode.type === 'llm') {
        promptTextarea.value = prompts[state.selectedPrompt] || '';
      } else if (selectedNode.type === 'python') {
        promptTextarea.value = scripts[state.selectedPrompt] || '';
      }
    } else {
      promptTextarea.value = '';
      promptTextarea.disabled = true;
    }
  }

  function updateNodeOptions() {
    const nodeIds = state.currentWorkflow.config.nodes.map(n => n.id);
    const optionsHtml = nodeIds.map(id => `<option value="${id}">${id}</option>`).join('');
    const endOptionHtml = '<option value="__end__">END (終了)</option>';
    document.querySelectorAll('.edge-source').forEach(select => {
      const currentValue = state.currentWorkflow.config.edges[select.dataset.index]?.source;
      select.innerHTML = optionsHtml;
      if (nodeIds.includes(currentValue)) select.value = currentValue;
    });
    document.querySelectorAll('.edge-target').forEach(select => {
      const currentValue = state.currentWorkflow.config.edges[select.dataset.index]?.target;
      select.innerHTML = optionsHtml + endOptionHtml;
      if ([...nodeIds, '__end__'].includes(currentValue)) select.value = currentValue;
    });
    const currentEntryPoint = entryPointSelect.value;
    entryPointSelect.innerHTML = optionsHtml;
    if (nodeIds.includes(currentEntryPoint)) {
      entryPointSelect.value = currentEntryPoint;
    } else {
      entryPointSelect.value = state.currentWorkflow.config.entry_point;
    }
  }

  // --- イベントリスナー ---

  fileUploadInput.addEventListener('change', () => {
    const file = fileUploadInput.files[0];
    if (file && file.name.toLowerCase().endsWith('.zip')) {
      zipOptions.style.display = 'block';
    } else {
      zipOptions.style.display = 'none';
    }
  });

  uploadFileBtn.addEventListener('click', async () => {
    if (!state.currentWorkflow) return;

    const file = fileUploadInput.files[0];
    const outputKey = fileOutputKeyInput.value.trim();

    fileError.style.display = 'none';

    if (!file) {
      fileError.textContent = 'ファイルを選択してください。';
      fileError.style.display = 'block';
      return;
    }
    if (!outputKey) {
      fileError.textContent = 'Stateの出力キーを入力してください。';
      fileError.style.display = 'block';
      return;
    }

    const formData = new FormData();
    formData.append('file', file);
    formData.append('outputKey', outputKey);

    if (zipOptions.style.display === 'block') {
      formData.append('excludedExtensions', excludedExtensionsInput.value);
    }

    fileUploadSpinner.style.display = 'block';
    uploadFileBtn.disabled = true;

    try {
      await fetchAPI(`/api/workflows/${state.currentWorkflow.id}/upload`, {
        method: 'POST',
        body: formData,
      });
      await loadWorkflowDetail(state.currentWorkflow.id);
      fileUploadInput.value = '';
      fileOutputKeyInput.value = '';
      excludedExtensionsInput.value = '';
      zipOptions.style.display = 'none';
    } catch (error) {
      console.error('File upload failed:', error);
      fileError.textContent = `アップロード失敗: ${error.message}`;
      fileError.style.display = 'block';
    } finally {
      fileUploadSpinner.style.display = 'none';
      uploadFileBtn.disabled = false;
    }
  });

  fileList.addEventListener('click', async (e) => {
    const deleteBtn = e.target.closest('.delete-file-btn');
    if (deleteBtn && state.currentWorkflow) {
      const fileName = deleteBtn.dataset.filename;
      if (!confirm(`ファイル「${fileName}」を本当に削除しますか？`)) return;

      try {
        await fetchAPI(`/api/workflows/${state.currentWorkflow.id}/files/${encodeURIComponent(fileName)}`, {
          method: 'DELETE',
        });
        await loadWorkflowDetail(state.currentWorkflow.id);
      } catch (error) {
        console.error('File deletion failed:', error);
        fileError.textContent = `削除失敗: ${error.message}`;
        fileError.style.display = 'block';
      }
    }
  });

  document.getElementById('add-node-btn').addEventListener('click', () => {
    const newNodeId = `node_${Date.now()}`;
    state.currentWorkflow.config.nodes.push({ id: newNodeId, type: 'llm', output_key: `` });
    renderAll();
    handleStateChange();
  });

  nodesList.addEventListener('click', e => {
    const deleteButton = e.target.closest('.delete-btn');
    if (deleteButton) {
      const index = deleteButton.dataset.index;
      const node = state.currentWorkflow.config.nodes[index];
      if (!node) return;
      state.currentWorkflow.config.nodes.splice(index, 1);
      state.currentWorkflow.config.edges = state.currentWorkflow.config.edges.filter(edge => edge.source !== node.id && edge.target !== node.id);
      delete state.currentWorkflow.prompts[node.id];
      delete state.currentWorkflow.scripts[node.id];
      if (state.selectedPrompt === node.id) state.selectedPrompt = null;
      renderAll();
      handleStateChange();
    }
  });

  document.getElementById('add-edge-btn').addEventListener('click', () => {
    const nodes = state.currentWorkflow.config.nodes;
    const source = nodes.length > 0 ? nodes[0].id : '';
    const target = nodes.length > 1 ? nodes[1].id : '__end__';
    state.currentWorkflow.config.edges.push({ source, target, conditional: false });
    renderAll();
    handleStateChange();
  });

  edgesList.addEventListener('click', e => {
    if (e.target.closest('.delete-btn')) {
      state.currentWorkflow.config.edges.splice(e.target.closest('.delete-btn').dataset.index, 1);
      renderAll();
      handleStateChange();
    }
  });
  
  workflowNameInput.addEventListener('input', () => {
    if (state.currentWorkflow) {
      // state.currentWorkflow.name = workflowNameInput.value; // この行は不要、saveWorkflow内で処理される
      handleStateChange();
    }
  });

  nodesList.addEventListener('change', e => {
    const index = e.target.dataset.index;
    const node = state.currentWorkflow.config.nodes[index];
    if (!node) return;

    if (e.target.classList.contains('node-id')) {
      const oldId = node.id;
      const newId = e.target.value;
      node.id = newId;
      state.currentWorkflow.config.edges.forEach(edge => {
        if (edge.source === oldId) edge.source = newId;
        if (edge.target === oldId) edge.target = newId;
      });
      if (state.currentWorkflow.config.entry_point === oldId) state.currentWorkflow.config.entry_point = newId;
      if (state.currentWorkflow.prompts[oldId] !== undefined) {
        state.currentWorkflow.prompts[newId] = state.currentWorkflow.prompts[oldId];
        delete state.currentWorkflow.prompts[oldId];
      }
      if (state.currentWorkflow.scripts[oldId] !== undefined) {
        state.currentWorkflow.scripts[newId] = state.currentWorkflow.scripts[oldId];
        delete state.currentWorkflow.scripts[oldId];
      }
      if (state.selectedPrompt === oldId) state.selectedPrompt = newId;
      renderAll();
    } else if (e.target.classList.contains('node-type')) {
      node.type = e.target.value;
      renderAll();
    } else if (e.target.classList.contains('node-output-key')) {
      node.output_key = e.target.value;
    }
    handleStateChange();
  });

  edgesList.addEventListener('change', e => {
    const { index } = e.target.dataset;
    const edge = state.currentWorkflow.config.edges[index];
    if (!edge) return;
    if (e.target.classList.contains('edge-source')) edge.source = e.target.value;
    if (e.target.classList.contains('edge-target')) edge.target = e.target.value;
    if (e.target.classList.contains('edge-conditional')) edge.conditional = e.target.checked;
    renderGraph();
    handleStateChange();
  });

  entryPointSelect.addEventListener('change', () => {
    state.currentWorkflow.config.entry_point = entryPointSelect.value;
    renderGraph();
    handleStateChange();
  });

  finalOutputKeyInput.addEventListener('change', () => {
    state.currentWorkflow.config.final_output_key = finalOutputKeyInput.value;
    handleStateChange();
  });

  promptSelect.addEventListener('change', () => {
    state.selectedPrompt = promptSelect.value;
    renderEditor();
  });

  promptTextarea.addEventListener('input', () => {
    if (!state.selectedPrompt) return;
    const selectedNode = state.currentWorkflow.config.nodes.find(n => n.id === state.selectedPrompt);
    if (!selectedNode) return;
    if (selectedNode.type === 'llm') {
      state.currentWorkflow.prompts[state.selectedPrompt] = promptTextarea.value;
    } else if (selectedNode.type === 'python') {
      state.currentWorkflow.scripts[state.selectedPrompt] = promptTextarea.value;
    }
    handleStateChange();
  });

  // --- ワークフロー実行 ---
  document.getElementById('execute-btn').addEventListener('click', async () => {
    if (!state.currentWorkflow || !state.currentWorkflow.id) {
      alert("ワークフローを保存してから実行してください。");
      return;
    }

    const inputTextArea = document.getElementById('workflow-input');
    const spinner = document.getElementById('loading-spinner');
    const resultsArea = document.getElementById('results-area');
    const finalResultContent = document.getElementById('final-result-content');
    const fullStateContent = document.getElementById('full-state-content');

    spinner.style.display = 'block';
    resultsArea.style.display = 'block';
    finalResultContent.innerHTML = '実行中...';
    fullStateContent.innerHTML = '';
    resultsArea.querySelector('.tab-link[data-tab="final-output-tab"]').classList.add('active');
    resultsArea.querySelector('.tab-link[data-tab="full-state-tab"]').classList.remove('active');
    document.getElementById('final-output-tab').classList.add('active');
    document.getElementById('full-state-tab').classList.remove('active');

    try {
      const result = await fetchAPI(`/api/workflows/${state.currentWorkflow.id}/execute`, {
        method: 'POST',
        body: JSON.stringify({ input: inputTextArea.value })
      });
      let finalDoc = result.final_document;
      let finalDocMarkdown = (typeof finalDoc === 'string') ? finalDoc :
        (finalDoc !== null && typeof finalDoc === 'object') ? '```json\n' + JSON.stringify(finalDoc, null, 2) + '\n```' :
        String(finalDoc);
      finalResultContent.innerHTML = marked.parse(finalDocMarkdown);

      const fullStateMarkdown = '```json\n' + JSON.stringify(result.full_state, null, 2) + '\n```';
      fullStateContent.innerHTML = marked.parse(fullStateMarkdown);

    } catch (error) {
      console.error(error);
      const errorMessage = `**エラー:** ${error.message}`;
      finalResultContent.innerHTML = marked.parse(errorMessage);
      fullStateContent.innerHTML = marked.parse('エラーが発生しました。詳細はブラウザのコンソールを確認してください。');
    } finally {
      spinner.style.display = 'none';
    }
  });
});
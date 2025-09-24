# main.py
import os
import json
import traceback
import re
import io
import zipfile
from typing import TypedDict, Any, Dict, Type, List
from pathlib import Path
from datetime import datetime

import functions_framework
from google.cloud import storage, firestore
from google.cloud.firestore_v1.base_query import FieldFilter
from firebase_admin import credentials, initialize_app, auth
import pandas as pd
from typing import TypedDict, Any, Dict, Type, List, Annotated

from RestrictedPython import compile_restricted
from RestrictedPython.Guards import safe_builtins, safer_getattr, full_write_guard, guarded_iter_unpack_sequence

from langchain_google_vertexai import VertexAI
from langchain_core.prompts import PromptTemplate
from langchain_core.output_parsers import StrOutputParser
from langgraph.graph import StateGraph, END

# --- グローバル変数の定義 ---
PROJECT_ID = os.environ.get("PROJECT_ID")
PROJECT_REGION = os.environ.get("PROJECT_REGION")
GEMINI_MODEL_NAME = os.environ.get("GEMINI_MODEL_NAME")
FILE_BUCKET_NAME = os.environ.get("FILE_BUCKET_NAME")

# --- Firebase Admin SDKの初期化 ---
if os.path.exists("./credential.json"):
    os.environ["GOOGLE_APPLICATION_CREDENTIALS"] = os.path.abspath("./credential.json")
    cred = credentials.Certificate(os.environ["GOOGLE_APPLICATION_CREDENTIALS"])
    initialize_app(cred)
else:
    initialize_app()


# --- モデルとクライアントの初期化 ---
llm = VertexAI(model_name=GEMINI_MODEL_NAME)
db = firestore.Client()
storage_client = storage.Client()


# --- 認証ヘルパー関数 ---
def _get_uid_from_request(request):
    """リクエストヘッダーからIDトークンを検証し、UIDを返す"""
    auth_header = request.headers.get("Authorization")
    if not auth_header or not auth_header.startswith("Bearer "):
        raise PermissionError("Authorization header is missing or invalid.")
    
    id_token = auth_header.split("Bearer ")[1]
    try:
        decoded_token = auth.verify_id_token(id_token)
        return decoded_token['uid']
    except Exception as e:
        raise PermissionError(f"Invalid ID token: {e}")

# --- Zipファイル解析ヘルパー関数 ---
def _parse_zip_file(zip_content_bytes: bytes, additional_excluded_extensions: List[str] = None) -> dict:
    """
    メモリ上のZIPファイルコンテンツを解析し、指定されたルールでフィルタリングする。
    ユーザーが指定した追加の除外拡張子も考慮する。
    """
    print("--- Parsing ZIP file content ---")

    # --- 除外ルールの定義 ---
    # 基本の除外ルール
    EXCLUDED_EXTENSIONS = (
        # # 画像・メディア・フォント
        # '.png', '.jpg', '.jpeg', '.gif', '.bmp', '.ico', '.webp', '.svg',
        # '.mp3', '.wav', '.mp4', '.mov', '.avi', '.ttf', '.otf', '.woff',
        # # コンパイル済み/バイナリ
        # '.pyc', '.class', '.jar', '.o', '.so', '.dll', '.exe',
        # # アーカイブ・DB・ログ
        # '.zip', '.gz', '.tar', '.rar', '.sqlite', '.db', '.log',
    )
    # ユーザー指定の除外拡張子を追加
    if additional_excluded_extensions:
        # タプルに変換して結合
        all_excluded_extensions = EXCLUDED_EXTENSIONS + tuple(additional_excluded_extensions)
    else:
        all_excluded_extensions = EXCLUDED_EXTENSIONS
        
    EXCLUDED_FILES = (
        # '.ds_store', 'thumbs.db', 'license', 'license.md',
        # 'package-lock.json', 'yarn.lock', 'pipfile.lock', 'poetry.lock',
        # '.gitignore', '.gitattributes'
    )
    EXCLUDED_DIRS = (
        # '__MACOSX/', '.git/', 'node_modules/', 'vendor/', 'bower_components/',
        # 'build/', 'dist/', 'target/', 'out/',
        # '.vscode/', '.idea/', '.project/', '.settings/',
        # '.cache/', '.next/', '.nuxt/'
    )
    # -----------------------

    try:
        file_contents = {}
        with io.BytesIO(zip_content_bytes) as zip_buffer:
            with zipfile.ZipFile(zip_buffer, 'r') as zip_ref:
                file_list = zip_ref.namelist()
                for file_path in file_list:
                    # ディレクトリ自体はスキップ
                    if file_path.endswith('/'):
                        continue

                    # --- 除外フィルタリング処理 ---
                    lower_file_path = file_path.lower()
                    if (lower_file_path.startswith(EXCLUDED_DIRS) or
                        os.path.basename(lower_file_path) in EXCLUDED_FILES or
                        lower_file_path.endswith(all_excluded_extensions)):
                        print(f"Skipping (excluded): {file_path}")
                        continue
                    # ---------------------------

                    try:
                        # 解析対象のファイルのみ読み込む
                        file_contents[file_path] = zip_ref.read(file_path).decode('utf-8')
                    except UnicodeDecodeError:
                        # UTF-8でデコードできないファイルもスキップ
                        print(f"Skipping (non-utf8): {file_path}")
                        continue
        
        if not file_contents:
            return {"error": "No analyzable source code files found in the zip archive after filtering."}

        file_list_str = "\n".join(file_contents.keys())
        print(f"Analyzed {len(file_contents)} files from ZIP.")
        return {"file_contents": file_contents, "file_list_str": file_list_str}
    except Exception as e:
        traceback.print_exc()
        return {"error": f"ZIP File Analyzer Error: {e}"}

# --- MCP/ファイル処理ヘルパー関数 ---
def _load_files_to_state(files_metadata: List[Dict[str, str]]) -> Dict[str, Any]:
    """
    Firestoreに記録されたファイルメタデータを元に、GCSからファイルを読み込み、
    パースしてStateに追加する辞書を返す。
    """
    if not FILE_BUCKET_NAME:
        print("Warning: FILE_BUCKET_NAME is not set. Skipping file loading.")
        return {}
        
    loaded_data = {}
    bucket = storage_client.bucket(FILE_BUCKET_NAME)

    for file_meta in files_metadata:
        gcs_path = file_meta.get("gcsPath")
        output_key = file_meta.get("outputKey")
        
        if not gcs_path or not output_key:
            print(f"Warning: Skipping file due to missing gcsPath or outputKey: {file_meta}")
            continue

        try:
            print(f"--- Loading file '{gcs_path}' into state key '{output_key}' ---")
            blob = bucket.blob(gcs_path)
            if not blob.exists():
                raise FileNotFoundError(f"File not found in GCS: {gcs_path}")

            file_content_bytes = blob.download_as_bytes()
            content_type = blob.content_type

            if content_type == "text/plain" or content_type == "application/json":
                loaded_data[output_key] = file_content_bytes.decode('utf-8')
            elif content_type == "text/csv":
                df = pd.read_csv(io.BytesIO(file_content_bytes))
                loaded_data[output_key] = df.to_dict(orient='records')
            elif content_type == "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet":
                df = pd.read_excel(io.BytesIO(file_content_bytes))
                loaded_data[output_key] = df.to_dict(orient='records')
            # 修正: Zipファイルの処理を追加
            elif content_type in ("application/zip", "application/x-zip-compressed"):
                print(f"Processing ZIP file '{gcs_path}'...")
                additional_exclusions = file_meta.get("excludedExtensions", [])
                parsed_data = _parse_zip_file(file_content_bytes, additional_exclusions)
                
                # 解析結果をoutputKeyにセット。エラーもそのまま格納する
                loaded_data[output_key] = parsed_data
            else:
                # サポート外の形式はとりあえずテキストとして読み込む
                print(f"Warning: Unsupported content type '{content_type}' for '{gcs_path}'. Loading as text.")
                loaded_data[output_key] = file_content_bytes.decode('utf-8', errors='ignore')

        except Exception as e:
            traceback.print_exc()
            # ファイル読み込みエラーはワークフロー全体を停止させず、エラーメッセージをStateに入れる
            error_key = f"{output_key}_error"
            loaded_data[error_key] = f"Failed to load file '{gcs_path}': {str(e)}"

    return loaded_data

# --- ユーティリティ関数 ---
def get_raw_content(content_dict: Dict, content_type: str, content_name: str) -> str:
    if content_type not in content_dict or content_name not in content_dict[content_type]:
        raise FileNotFoundError(f"{content_type.capitalize()} '{content_name}' not found in workflow data.")
    return content_dict[content_type][content_name]

def _get_value_from_state(state: dict, key_path: str):
    key_path = re.sub(r"\[['\"]?(.+?)['\"]?\]", r".\1", key_path)
    keys = key_path.split('.')
    value = state
    for key in keys:
        if isinstance(value, dict) and key in value:
            value = value[key]
        else:
            return None
    return value
    
# --- LangGraph構築 ---
def create_dynamic_agent_state(config: Dict[str, Any]) -> Type[TypedDict]:
    state_keys: Dict[str, Any] = { "input": str, "error": str }
    
    # ファイルから読み込むキーも動的に追加される
    for file_config in config.get('files', []):
        output_key = file_config.get('outputKey')
        if output_key:
            state_keys[output_key] = Any

    for node_config in config.get('nodes', []):
        output_key = node_config.get('output_key')
        if output_key:
            if output_key.endswith("+"):
                key_name = output_key[:-1]
                state_keys[key_name] = Annotated[List[Any], lambda old_list, new_list: old_list + new_list]
            else:
                state_keys[output_key] = Any
                
    final_output_key = config.get('final_output_key')
    if final_output_key: state_keys[final_output_key] = Any
    
    print(f"--- Dynamically created AgentState keys: {list(state_keys.keys())} ---")
    return TypedDict('AgentState', state_keys, total=False)


def create_llm_node(prompt_name: str, workflow_data: Dict):
    def node_function(state: Dict[str, Any]) -> dict:
        print(f"--- Running LLM Node: {prompt_name} ---")
        if state.get("error"): return {}
        try:
            raw_prompt_template = get_raw_content(workflow_data, "prompts", prompt_name)

            def format_variable(match):
                var_path = match.group(1)
                
                if var_path == 'input':
                    return f"{{{var_path}}}"

                value = _get_value_from_state(state, var_path)
                
                if value is not None:
                    if isinstance(value, (dict, list)):
                        value_str = json.dumps(value, ensure_ascii=False)
                    else:
                        value_str = str(value)
                    
                    escaped_value = value_str.replace("{", "{{").replace("}", "}}")
                    return escaped_value
                
                raise KeyError(f"Variable '{var_path}' not found in state.")

            formatted_prompt_str = re.sub(r"\{(.+?)\}", format_variable, raw_prompt_template)
            
            prompt = PromptTemplate.from_template(formatted_prompt_str)
            
            chain = prompt | llm | StrOutputParser()

            invoke_input = {}
            if 'input' in prompt.input_variables and 'input' in state:
                invoke_input['input'] = state['input']
            
            result = chain.invoke(invoke_input)

            node_config = next((n for n in workflow_data['config'].get('nodes', []) if n['id'] == prompt_name), None)
            if not node_config: raise ValueError(f"Node config for '{prompt_name}' not found.")
            output_key = node_config.get('output_key')
            if not output_key: return {}
            
            if output_key.endswith("+"):
                key = output_key[:-1]
                return {key: [result]}
            else:
                return {output_key: result}
        except Exception as e:
            traceback.print_exc()
            return {"error": f"Error in llm node '{prompt_name}': {str(e)}"}
    return node_function

def create_python_node(script_name: str, workflow_data: Dict):
    """PythonコードをRestrictedPythonを用いて安全に実行するノードを作成する高階関数"""
    def node_function(state: Dict[str, Any]) -> dict:
        print(f"--- Running Python Node: {script_name} ---")
        if state.get("error"): return {}
        try:
            script_code = get_raw_content(workflow_data, "scripts", script_name)
            
            # RestrictedPython用の安全な実行環境を定義
            restricted_globals = {
                "__builtins__": safe_builtins,
                "_getiter_": iter,
                "_getitem_": lambda obj, key: obj[key],
                "_write_": full_write_guard,
                "getattr": safer_getattr,
                
                # シーケンスアンパッキング（例: a, b = [1, 2]）を許可するためのヘルパー関数
                'iter_unpack_sequence': guarded_iter_unpack_sequence,

                # forループなど、別の種類のアンパッキングに対応するためのヘルパー関数
                '_iter_unpack_sequence_': guarded_iter_unpack_sequence,

                # ユーザーのスクリプト内で使用を許可する安全な組み込み型
                "list": list,
                "dict": dict,
                "set": set,
                "str": str,
                "int": int,
                "float": float,
                "bool": bool,
                "tuple": tuple,

                # ユーザーに公開したい安全なツール
                "json": json,
                "llm": llm,
                "PromptTemplate": PromptTemplate,
                "StrOutputParser": StrOutputParser,
            }
            
            # 信頼できないコードを、制限された環境でコンパイル
            byte_code = compile_restricted(
                script_code,
                filename=f"<safe_script_{script_name}>",
                mode='exec'
            )
            
            local_scope = {}
            
            # コンパイルされた安全なバイトコードを実行
            exec(byte_code, restricted_globals, local_scope)

            if 'main' not in local_scope or not callable(local_scope['main']):
                raise TypeError(f"Script '{script_name}.py' must define a 'main(state)' function.")
            
            result = local_scope['main'](state)
            
            node_config = next((n for n in workflow_data['config'].get('nodes', []) if n['id'] == script_name), None)
            if not node_config: raise ValueError(f"Node config for '{script_name}' not found.")
            output_key = node_config.get('output_key')
            if not output_key: return {}
            
            if output_key.endswith("+"):
                key = output_key[:-1]
                return {key: [result]}
            else:
                return {output_key: result}
                
        except Exception as e:
            traceback.print_exc()
            return {"error": f"Error in python node '{script_name}': {str(e)}"}
            
    return node_function

def join_node(state: Dict[str, Any]) -> dict:
    print(f"--- Running a Join Node ---")
    return {}

def build_graph_from_config(workflow_data: dict, agent_state_class: Type[TypedDict]):
    config = workflow_data['config']
    workflow = StateGraph(agent_state_class)
    for node_config in config.get('nodes', []):
        node_id, node_type = node_config['id'], node_config['type']
        if node_type == 'llm':
            workflow.add_node(node_id, create_llm_node(node_id, workflow_data))
        elif node_type == 'join':
            workflow.add_node(node_id, join_node)
        elif node_type == 'python':
            workflow.add_node(node_id, create_python_node(node_id, workflow_data))
    workflow.set_entry_point(config["entry_point"])
    for edge_config in config["edges"]:
        source, target = edge_config["source"], edge_config["target"]
        if target == "__end__": target = END
        if edge_config.get("conditional", False):
            def condition(state: Dict[str, Any]): return "end" if state.get("error") else "continue"
            workflow.add_conditional_edges(source, condition, {"continue": target, "end": END})
        else:
            workflow.add_edge(source, target)
    return workflow.compile()


# --- HTTPリクエストハンドラ ---
@functions_framework.http
def handle_request(request):
    base_headers = {
        'Access-Control-Allow-Origin': '*',
        'Access-Control-Allow-Methods': 'GET, POST, PUT, DELETE, OPTIONS',
        'Access-Control-Allow-Headers': 'Content-Type, Authorization',
    }
    if request.method == 'OPTIONS':
        return ('', 204, base_headers)

    path_parts = request.path.strip('/').split('/')
    
    if path_parts[0] == '' or path_parts[0] == 'static':
        filepath = 'static/index.html' if path_parts[0] == '' else request.path.lstrip('/')
        if os.path.exists(filepath):
            response_headers = base_headers.copy()
            content_type = 'text/html; charset=utf-8'
            if filepath.endswith('.js'): content_type = 'application/javascript; charset=utf-8'
            if filepath.endswith('.css'): content_type = 'text/css; charset=utf-8'
            response_headers['Content-Type'] = content_type
            with open(filepath, 'r', encoding='utf-8') as f: content = f.read()
            return (content, 200, response_headers)
        else:
            response_headers = base_headers.copy()
            response_headers['Content-Type'] = 'application/json; charset=utf-8'
            return (json.dumps({"error": "Not Found"}), 404, response_headers)

    # APIルーティング
    if path_parts[0] == 'api':
        response_headers = base_headers.copy()
        response_headers['Content-Type'] = 'application/json; charset=utf-8'

        try:
            uid = _get_uid_from_request(request)
            workflows_collection = db.collection('workflows')

            if len(path_parts) == 2 and path_parts[1] == 'workflows' and request.method == 'GET':
                docs = workflows_collection.where(filter=FieldFilter('userId', '==', uid)).stream()
                workflows = [{"id": doc.id, "name": doc.to_dict().get('name', 'Untitled')} for doc in docs]
                return (json.dumps(workflows), 200, response_headers)

            if len(path_parts) == 2 and path_parts[1] == 'workflows' and request.method == 'POST':
                data = request.get_json()
                new_workflow = {
                    'userId': uid,
                    'name': data.get('name', 'New Workflow'),
                    'config': data.get('config'),
                    'prompts': data.get('prompts'),
                    'scripts': data.get('scripts'),
                    'files': data.get('files', []),
                    'createdAt': datetime.now(),
                    'updatedAt': datetime.now(),
                }
                update_time, doc_ref = workflows_collection.add(new_workflow)
                return (json.dumps({"id": doc_ref.id, "message": "Workflow created"}), 201, response_headers)

            if len(path_parts) == 3 and path_parts[1] == 'workflows' and request.method == 'GET':
                workflow_id = path_parts[2]
                doc_ref = workflows_collection.document(workflow_id)
                doc = doc_ref.get()
                if not doc.exists or doc.to_dict().get('userId') != uid:
                    return (json.dumps({"error": "Workflow not found or access denied"}), 404, response_headers)
                workflow_data = doc.to_dict()
                workflow_data['createdAt'] = str(workflow_data.get('createdAt'))
                workflow_data['updatedAt'] = str(workflow_data.get('updatedAt'))
                return (json.dumps(workflow_data), 200, response_headers)

            if len(path_parts) == 3 and path_parts[1] == 'workflows' and request.method == 'PUT':
                workflow_id = path_parts[2]
                doc_ref = workflows_collection.document(workflow_id)
                doc = doc_ref.get()
                if not doc.exists or doc.to_dict().get('userId') != uid:
                    return (json.dumps({"error": "Workflow not found or access denied"}), 404, response_headers)
                data = request.get_json()
                data['updatedAt'] = datetime.now()
                doc_ref.update(data)
                return (json.dumps({"message": "Workflow updated"}), 200, response_headers)

            if len(path_parts) == 3 and path_parts[1] == 'workflows' and request.method == 'DELETE':
                workflow_id = path_parts[2]
                doc_ref = workflows_collection.document(workflow_id)
                doc = doc_ref.get()
                doc_data = doc.to_dict()
                if not doc.exists or doc_data.get('userId') != uid:
                    return (json.dumps({"error": "Workflow not found or access denied"}), 404, response_headers)
                
                if FILE_BUCKET_NAME and 'files' in doc_data:
                    bucket = storage_client.bucket(FILE_BUCKET_NAME)
                    for file_meta in doc_data['files']:
                        if 'gcsPath' in file_meta:
                            print(f"Deleting GCS object: {file_meta['gcsPath']}")
                            blob = bucket.blob(file_meta['gcsPath'])
                            if blob.exists():
                                blob.delete()
                
                doc_ref.delete()
                return (json.dumps({"message": "Workflow deleted"}), 200, response_headers)

            # --- ファイルアップロード (POST /api/workflows/{id}/upload) ---
            if len(path_parts) == 4 and path_parts[1] == 'workflows' and path_parts[3] == 'upload' and request.method == 'POST':
                workflow_id = path_parts[2]
                doc_ref = workflows_collection.document(workflow_id)
                doc = doc_ref.get()
                if not doc.exists or doc.to_dict().get('userId') != uid:
                    return (json.dumps({"error": "Workflow not found or access denied"}), 404, response_headers)
                
                if 'file' not in request.files:
                    return (json.dumps({"error": "No file part in the request"}), 400, response_headers)
                
                file = request.files['file']
                output_key = request.form.get('outputKey')
                excluded_extensions_str = request.form.get('excludedExtensions', '')

                if not file.filename:
                    return (json.dumps({"error": "No selected file"}), 400, response_headers)
                if not output_key:
                    return (json.dumps({"error": "'outputKey' is required"}), 400, response_headers)

                bucket = storage_client.bucket(FILE_BUCKET_NAME)
                gcs_path = f"users/{uid}/{workflow_id}/{file.filename}"
                blob = bucket.blob(gcs_path)
                
                blob.upload_from_file(file, content_type=file.content_type)
                
                # 除外拡張子をリストに変換
                excluded_extensions_list = []
                if excluded_extensions_str:
                    # カンマで分割し、前後の空白を除去、'.'がなければ付与する
                    excluded_extensions_list = [
                        f".{ext.strip().lstrip('.')}" for ext in excluded_extensions_str.split(',') if ext.strip()
                    ]

                new_file_meta = {
                    "fileName": file.filename,
                    "outputKey": output_key,
                    "gcsPath": gcs_path,
                    "contentType": file.content_type,
                    "excludedExtensions": excluded_extensions_list
                }
                
                doc_ref.update({
                    "files": firestore.ArrayUnion([new_file_meta])
                })
                
                return (json.dumps(new_file_meta), 200, response_headers)

            # ... (DELETE /api/workflows/{id}/files/{file_name}) ...
            if len(path_parts) == 5 and path_parts[1] == 'workflows' and path_parts[3] == 'files' and request.method == 'DELETE':
                workflow_id = path_parts[2]
                file_name_to_delete = path_parts[4]
                doc_ref = workflows_collection.document(workflow_id)
                doc = doc_ref.get()
                doc_data = doc.to_dict()

                if not doc.exists or doc_data.get('userId') != uid:
                    return (json.dumps({"error": "Workflow not found or access denied"}), 404, response_headers)

                gcs_path = f"users/{uid}/{workflow_id}/{file_name_to_delete}"
                bucket = storage_client.bucket(FILE_BUCKET_NAME)
                blob = bucket.blob(gcs_path)
                if blob.exists():
                    blob.delete()
                
                files_to_keep = [f for f in doc_data.get('files', []) if f.get('fileName') != file_name_to_delete]
                doc_ref.update({"files": files_to_keep})
                
                return (json.dumps({"message": f"File '{file_name_to_delete}' deleted"}), 200, response_headers)


            # ... (POST /api/workflows/{id}/execute) ...
            if len(path_parts) == 4 and path_parts[1] == 'workflows' and path_parts[3] == 'execute' and request.method == 'POST':
                workflow_id = path_parts[2]
                doc_ref = workflows_collection.document(workflow_id)
                doc = doc_ref.get()
                if not doc.exists or doc.to_dict().get('userId') != uid:
                    return (json.dumps({"error": "Workflow not found or access denied"}), 404, response_headers)

                request_data = request.get_json(silent=True)
                if not request_data or 'input' not in request_data:
                    return (json.dumps({"error": "JSON payload with 'input' key is required."}), 400, response_headers)

                workflow_data = doc.to_dict()
                config = workflow_data.get('config', {})
                config['files'] = workflow_data.get('files', []) # State生成のためにファイル情報もconfigに含める

                DynamicAgentState = create_dynamic_agent_state(config)
                app = build_graph_from_config(workflow_data, DynamicAgentState)
                
                initial_state = {"input": request_data.get('input', '')}
                file_data = _load_files_to_state(workflow_data.get('files', []))
                initial_state.update(file_data)
                
                final_state = app.invoke(initial_state)

                if final_state.get("error"):
                    return (json.dumps({"error": final_state["error"]}), 500, response_headers)

                final_output_key = config.get("final_output_key", "final_document")
                final_doc = final_state.get(final_output_key, "No final document generated.")
                response_data = {"final_document": final_doc, "full_state": final_state}
                
                def default_serializer(obj):
                    try: return str(obj)
                    except TypeError: return f"<non-serializable: {type(obj).__qualname__}>"
                
                return (json.dumps(response_data, ensure_ascii=False, indent=2, default=default_serializer), 200, response_headers)

        except PermissionError as e:
            return (json.dumps({"error": str(e)}), 401, response_headers)
        except Exception as e:
            traceback.print_exc()
            return (json.dumps({"error": f"Internal Server Error: {str(e)}"}), 500, response_headers)

    # APIルートが見つからない場合
    response_headers = base_headers.copy()
    response_headers['Content-Type'] = 'application/json; charset=utf-8'
    return (json.dumps({"error": "API Route Not Found"}), 404, response_headers)
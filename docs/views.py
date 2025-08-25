import json
import httpx
from django.conf import settings
from django.db.models import Q
from rest_framework import status, viewsets
from rest_framework.decorators import action, api_view, permission_classes
from rest_framework.permissions import IsAuthenticated
from rest_framework.response import Response
from django.http import StreamingHttpResponse

from .models import Document, DocumentVersion
from .serializers import DocumentSerializer, DocumentCreateSerializer
from .permissions import IsOwner

AI_URL = settings.AI_PROVIDER_URL

class DocumentViewSet(viewsets.ModelViewSet):
    queryset = Document.objects.all()
    serializer_class = DocumentSerializer
    permission_classes = [IsAuthenticated, IsOwner]

    def get_queryset(self):
        qs = Document.objects.filter(owner=self.request.user, is_deleted=False)
        q = self.request.query_params.get("q")
        if q:
            # быстрый поиск по названию и содержимому
            qs = qs.filter(Q(title__icontains=q) | Q(content_html__icontains=q))
        return qs

    def get_serializer_class(self):
        if self.action in ["create", "update", "partial_update"]:
            return DocumentCreateSerializer
        return DocumentSerializer

    def perform_create(self, serializer):
        doc = serializer.save(owner=self.request.user)
        # создаём первую версию
        DocumentVersion.objects.create(document=doc, label="v1", content_html=doc.content_html)

    def perform_update(self, serializer):
        doc = serializer.save()
        # снапшот версии
        label = f"v{doc.versions.count()+1}"
        DocumentVersion.objects.create(document=doc, label=label, content_html=doc.content_html)

    def perform_destroy(self, instance):
        # мягкое удаление
        instance.is_deleted = True
        instance.save(update_fields=["is_deleted"])

    @action(detail=True, methods=["post"])
    def snapshot(self, request, pk=None):
        doc = self.get_object()
        label = request.data.get("label") or f"v{doc.versions.count()+1}"
        DocumentVersion.objects.create(document=doc, label=label, content_html=doc.content_html)
        return Response({"ok": True, "label": label})

    @action(detail=True, methods=["get"])
    def export(self, request, pk=None):
        doc = self.get_object()
        html = f'<!DOCTYPE html><html><head><meta charset="utf-8"><title>{doc.title}</title></head><body>{doc.content_html}</body></html>'
        return Response(html, content_type="text/html")

    @action(detail=False, methods=["post"])
    def import_html(self, request):
        title = request.data.get("title") or "Импортированный документ"
        html = request.data.get("content_html") or ""
        doc = Document.objects.create(owner=request.user, title=title, content_html=html)
        DocumentVersion.objects.create(document=doc, label="v1", content_html=html)
        return Response(DocumentSerializer(doc).data, status=201)


def build_payload(mode: str, prompt: str, html: str, selection: str, *, stream: bool = False):
    """
    Формируем payload в формате, которого ждёт твой n8n:
    {
        "messages": [
            {"role":"system","content":"..."},
            {"role":"user","content":"..."}
        ],
        "temperature": 0.7, "top_p": 0.95, "max_tokens": 1024, "stream": false|true
    }
    """
    system_msg = (
        "Ты профессиональный русскоязычный автор деловых документов. "
        "Готовишь ТЗ, коммерческие предложения (КП), стратегии (продуктовые/маркетинговые/Go-to-Market), "
        "PRD/BRD, политики и регламенты, инструкции и руководства, отчёты, протоколы встреч, "
        "технические записки, дорожные карты (roadmap), OKR/KPI-планы, контент-планы и методички.\n"
        "\n"
        "Принципы:\n"
        "• Не придумывай фейтовые данные: не указывай ответственных, бюджеты, компании, даты и фамилии, если их не дали. "
        "Вместо этого помечай как TBD или делай нейтральные шаблонные пункты без персоналий.\n"
        "• Пиши кратко и по делу, деловым стилем. Никаких приветствий и «воды».\n"
        "• Всегда выдавай структурированный документ.\n"
        "\n"
        "Формат вывода по умолчанию — Markdown (русский язык):\n"
        "• Заголовки: # H1, ## H2, ### H3.\n"
        "• Списки: -, 1.\n"
        "• Таблицы: Markdown-таблицы (| колонки | … |) с заголовком и разделителем.\n"
        "• Код/JSON — в ```блоках кода```.\n"
        "Если в запросе явно встречается «html», «верни html», «формат html» — верни чистый HTML с <h1>/<h2>/<ul>/<table>, без <script> и стилей.\n"
        "\n"
        "Рамочные разделы, которые можно применять по контексту задачи:\n"
        "• Цели/Область/Термины • Роли и доступы • Функциональные/Нефункциональные требования • Данные и модели • API/Интеграции • UX-потоки\n"
        "• План/Этапы/Дедлайны (без фиксации дат, если не даны) • Риски и допущения • Критерии приёмки (чек-лист).\n"
        "\n"
        "Специальные форматы:\n"
        "• Контент-план — таблица: Дата | Канал/площадка | Формат | Тема/UGC | Цель/метрика | CTA | Статус | TBD.\n"
        "• Стратегия — при необходимости разделы ICP/JTBD, сегменты, каналы, гипотезы, метрики. Денежные суммы не выдумывать — помечать TBD.\n"
        "• Статья/гайд — оглавление, H2/H3, тезисы, вывод, при необходимости список источников.\n"
        "\n"
        "Если вход неоднозначный или неполный, укажи «Допущения» отдельным разделом и продолжай.\n"
    )
    
    # Собираем user-сообщение из простых полей фронта
    if mode == "generate":
        user_msg = prompt
    elif mode == "rewrite":
        user_msg = f"Перепиши фрагмент: {selection}\n\nИнструкция: {prompt}"
    elif mode == "continue":
        ctx = (html or "")[-1000:]
        user_msg = f"Продолжи текст: {ctx}\n\nИнструкция: {prompt}"
    elif mode == "outline":
        src = (html or "")[:1000]
        user_msg = f"Составь план документа на основе:\n{src}\n\nИнструкция: {prompt}"
    else:
        user_msg = prompt or html or ""

    return {
        "messages": [
            {"role": "system", "content": system_msg},
            {"role": "user",   "content": user_msg}
        ],
        "temperature": 0.7,
        "top_p": 0.95,
        "stream": stream
    }


@api_view(["POST", "OPTIONS"])
@permission_classes([IsAuthenticated])
def ai_proxy(request):
    """
    Обычный (нестримовый) AI-эндпоинт:
    - принимает {mode, prompt, html, selection}
    - нормализует в {messages: [...], temperature, top_p, max_tokens, stream:false}
    - вызывает n8n
    - возвращает JSON от n8n как есть (если не JSON — вернём {"text": "..."}).

    Если тебе НУЖЕН стрим, используй /api/ai/stream/ (другая вью).
    """
    # CORS для фронта на другом origin (127.0.0.1:5500 → 127.0.0.1:8000)
    cors_headers = {
        "Access-Control-Allow-Origin": "*",
        "Access-Control-Allow-Headers": "Content-Type, Authorization",
        "Access-Control-Allow-Methods": "POST, OPTIONS",
    }
    if request.method == "OPTIONS":
        return Response(status=204, headers=cors_headers)

    # Забираем простые поля от фронта
    mode = request.data.get("mode", "generate")
    prompt = request.data.get("prompt", "") or ""
    html = request.data.get("html", "") or ""
    selection = request.data.get("selection", "") or ""

    # Собираем payload под твой n8n (НЕ стрим)
    payload = build_payload(mode, prompt, html, selection, stream=False)

    try:
        r = httpx.post(AI_URL, json=payload, timeout=120)

        # Пытаемся вернуть JSON как есть
        content_type = r.headers.get("content-type", "")
        if "application/json" in content_type:
            try:
                data = r.json()
                return Response(data, status=r.status_code, headers=cors_headers)
            except json.JSONDecodeError:
                pass  # упадём в текстовый путь ниже

        # Если провайдер вернул не JSON (или это SSE без stream=false) — соберём текст грубо
        text = r.text or ""
        # Попытка распарсить OpenAI-SSE (на случай, если на стороне n8n всё-таки включён stream)
        if "data:" in text:
            acc = []
            for line in text.splitlines():
                line = line.strip()
                if not line.startswith("data:"):
                    continue
                chunk = line[5:].strip()
                if chunk == "[DONE]":
                    break
                try:
                    j = json.loads(chunk)
                    choice = (j.get("choices") or [{}])[0]
                    delta = choice.get("delta") or {}
                    piece = delta.get("content") or delta.get("reasoning_content") or ""
                    if not piece:
                        # иногда финал приходит в message.content
                        msg = (choice.get("message") or {}).get("content") or ""
                        piece = msg
                    if piece:
                        acc.append(piece)
                except Exception:
                    # если это не JSON — добавим как сырой текст
                    if chunk:
                        acc.append(chunk)
            return Response({"text": "".join(acc)}, status=200, headers=cors_headers)

        # Иначе вернём как простой текст
        return Response({"text": text}, status=r.status_code, headers=cors_headers)

    except httpx.HTTPError as e:
        return Response({"error": str(e)}, status=502, headers=cors_headers)
      
      
@api_view(["OPTIONS", "POST"])
@permission_classes([IsAuthenticated])
def ai_proxy_stream(request):
    cors = {
        "Access-Control-Allow-Origin": "*",
        "Access-Control-Allow-Headers": "Content-Type, Authorization",
        "Access-Control-Allow-Methods": "POST, OPTIONS",
    }
    if request.method == "OPTIONS":
        return Response(status=204, headers=cors)

    mode = request.data.get("mode", "generate")
    prompt = request.data.get("prompt", "")
    html = request.data.get("html", "")
    selection = request.data.get("selection", "")

    # Собираем messages в зависимости от режима
    messages = [
        {"role": "system", "content": "Ты помощник, который помогает создавать документы."}
    ]

    if mode == "generate":
        messages.append({"role": "user", "content": prompt})
    elif mode == "rewrite":
        messages.append({
            "role": "user",
            "content": f"Перепиши этот фрагмент: {selection}\n\nИнструкция: {prompt}"
        })
    elif mode == "continue":
        ctx = request.data.get("context") or html[-1000:]
        messages.append({
            "role": "user",
            "content": f"Продолжи текст: {ctx}\n\nИнструкция: {prompt}"
        })
    elif mode == "outline":
        messages.append({
            "role": "user",
            "content": f"Составь план документа на основе:\n{html[:1000]}\n\nИнструкция: {prompt}"
        })
    else:
        messages.append({"role": "user", "content": prompt or html})

    payload = {"messages": messages}

    def sse_emit(event: str, data: str):
        return (f"event: {event}\n" + f"data: {data}\n\n").encode("utf-8")

    def stream():
        with httpx.stream("POST", settings.AI_PROVIDER_URL, json=payload, timeout=None) as r:
            for raw in r.iter_lines():
                if not raw:
                    continue
                line = raw.decode("utf-8")
                if not line.startswith("data:"):
                    line = "data: " + line
                data_str = line[5:].strip()
                if data_str == "[DONE]":
                    break
                try:
                    j = json.loads(data_str)
                    choice = (j.get("choices") or [{}])[0]
                    delta = choice.get("delta") or {}
                    if delta.get("reasoning_content"):
                        yield sse_emit("reasoning", delta["reasoning_content"])
                    if delta.get("content"):
                        yield sse_emit("content", delta["content"])
                except Exception:
                    yield sse_emit("content", data_str)
        yield b"event: done\ndata: [DONE]\n\n"

    resp = StreamingHttpResponse(stream(), content_type="text/event-stream")
    resp["Cache-Control"] = "no-cache"
    resp["X-Accel-Buffering"] = "no"
    for k, v in cors.items():
        resp[k] = v
    return resp
from django.urls import path, include
from rest_framework.routers import DefaultRouter
from .views import DocumentViewSet, ai_proxy, ai_proxy_stream

router = DefaultRouter()
router.register(r"documents", DocumentViewSet, basename="document")

urlpatterns = [
    path("", include(router.urls)),
    path("ai/", ai_proxy, name="ai-proxy"),
    path("ai/stream/", ai_proxy_stream, name="ai-stream"),  # стримовый SSE
]
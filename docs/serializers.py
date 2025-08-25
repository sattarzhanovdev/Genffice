from rest_framework import serializers
from .models import Document, DocumentVersion

class DocumentVersionSerializer(serializers.ModelSerializer):
    class Meta:
        model = DocumentVersion
        fields = ["id", "label", "content_html", "created_at"]

class DocumentSerializer(serializers.ModelSerializer):
    versions = DocumentVersionSerializer(many=True, read_only=True)

    class Meta:
        model = Document
        fields = ["id", "title", "content_html", "is_deleted", "created_at", "updated_at", "versions"]

class DocumentCreateSerializer(serializers.ModelSerializer):
    class Meta:
        model = Document
        fields = ["title", "content_html"]
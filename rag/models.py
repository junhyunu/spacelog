"""임베딩 · 채팅 모델 고르기. cfg.fake 면 가짜 모델(OpenAI 를 부르지 않는다)."""

from itertools import cycle

from langchain_core.embeddings import DeterministicFakeEmbedding
from langchain_core.language_models.fake_chat_models import GenericFakeChatModel
from langchain_core.messages import AIMessage

FAKE_EMBED_SIZE = 64
DEFAULT_FAKE_REPLY = "가짜 답이에요."


def get_embeddings(cfg):
    if cfg.fake:
        return DeterministicFakeEmbedding(size=FAKE_EMBED_SIZE)
    from langchain_openai import OpenAIEmbeddings  # 가짜 모드에서는 불러오지 않는다

    return OpenAIEmbeddings(model=cfg.embed_model, api_key=cfg.api_key or None)


def fake_chat(responses=None):
    """정해 둔 답을 차례로 내는 가짜 채팅 모델. responses 가 없으면 같은 답을 계속 낸다.

    responses 항목은 문자열 또는 AIMessage. Task 4 테스트가 계획(JSON) · 답을 미리 정해 넣는다.
    """
    if responses is None:
        messages = cycle([AIMessage(content=DEFAULT_FAKE_REPLY)])
    else:
        messages = iter([r if isinstance(r, AIMessage) else AIMessage(content=r) for r in responses])
    return GenericFakeChatModel(messages=messages)


def get_chat(cfg, responses=None):
    if cfg.fake:
        return fake_chat(responses)
    from langchain_openai import ChatOpenAI

    return ChatOpenAI(model=cfg.model, temperature=0, api_key=cfg.api_key or None)

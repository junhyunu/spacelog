"""임베딩 · 채팅 모델 고르기. cfg.fake 면 가짜 모델(OpenAI 를 부르지 않는다)."""

import re
import threading
from typing import Any

from langchain_core.embeddings import DeterministicFakeEmbedding
from langchain_core.language_models.chat_models import BaseChatModel
from langchain_core.messages import AIMessage, AIMessageChunk
from langchain_core.outputs import ChatGeneration, ChatGenerationChunk, ChatResult
from pydantic import Field, PrivateAttr

FAKE_EMBED_SIZE = 64
DEFAULT_FAKE_REPLY = "가짜 답이에요."


def get_embeddings(cfg):
    if cfg.fake:
        return DeterministicFakeEmbedding(size=FAKE_EMBED_SIZE)
    from langchain_openai import OpenAIEmbeddings  # 가짜 모드에서는 불러오지 않는다

    return OpenAIEmbeddings(model=cfg.embed_model, api_key=cfg.api_key or None)


class ScriptedFakeChat(BaseChatModel):
    """정해 둔 답을 차례로 내는 가짜 채팅 모델(테스트용). 부른 기록을 남긴다.

    responses 항목:
      - 문자열 / AIMessage: 흘려 보낼 때는 공백 단위로 나눠 낸다.
      - 문자열 목록: 그 조각 그대로 하나씩 흘려 보낸다(invoke 면 이어 붙인다).
        목록 안의 예외 객체는 그 자리에 오면 던진다(흘려 보내는 중 오류).
      - 예외 객체: 부르자마자 던진다.
    responses 가 None 이면 같은 답을 계속 낸다. 다 쓰고 또 부르면 responder(messages) 의 답,
    responder 도 없으면 RuntimeError.
    """

    responses: list | None = None
    default_reply: str = DEFAULT_FAKE_REPLY
    responder: Any = None  # 대본이 끝난 뒤 메시지를 보고 답을 고르는 함수(선택)
    calls: list = Field(default_factory=list)  # 부를 때마다 받은 메시지 목록
    streamed: int = 0  # 실제로 흘려 보낸 조각 수(연결이 끊기면 멈췄는지 확인용)
    _lock: Any = PrivateAttr(default_factory=threading.Lock)

    @property
    def _llm_type(self) -> str:
        return "spacelog-scripted-fake"

    @property
    def call_count(self) -> int:
        return len(self.calls)

    def _next(self, messages):
        with self._lock:
            self.calls.append(list(messages))
            if self.responses is None:
                return self.default_reply
            if self.responses:
                item = self.responses.pop(0)
            elif self.responder is not None:
                item = None
            else:
                raise RuntimeError("scripted fake chat has no more responses")
        if item is None:
            item = self.responder(messages)
        if isinstance(item, BaseException):
            raise item
        return item

    @staticmethod
    def _pieces(item):
        if isinstance(item, AIMessage):
            item = item.content
        if isinstance(item, str):
            return [p for p in re.split(r"(\s)", item) if p]
        return list(item)

    def _generate(self, messages, stop=None, run_manager=None, **kwargs) -> ChatResult:
        pieces = self._pieces(self._next(messages))
        for p in pieces:
            if isinstance(p, BaseException):
                raise p
        text = "".join(pieces)
        return ChatResult(generations=[ChatGeneration(message=AIMessage(content=text))])

    def _stream(self, messages, stop=None, run_manager=None, **kwargs):
        for p in self._pieces(self._next(messages)):
            if isinstance(p, BaseException):
                raise p
            self.streamed += 1
            yield ChatGenerationChunk(message=AIMessageChunk(content=p))


def fake_chat(responses=None, responder=None):
    """정해 둔 답을 차례로 내는 가짜 채팅 모델. responses · responder 가 없으면 같은 답을 계속 낸다."""
    if responses is None and responder is not None:
        responses = []
    return ScriptedFakeChat(responses=None if responses is None else list(responses), responder=responder)


def get_chat(cfg, responses=None, responder=None):
    if cfg.fake:
        return fake_chat(responses, responder)
    from langchain_openai import ChatOpenAI

    # 수업 코드는 temperature=0 이지만, 그 값을 받지 않는 모델이 있어 .env 의 OPENAI_TEMPERATURE 가 있을 때만 보낸다.
    extra = {} if cfg.temperature is None else {"temperature": cfg.temperature}
    return ChatOpenAI(model=cfg.model, api_key=cfg.api_key or None, **extra)

package com.tianji.aigc.service.impl;

import cn.hutool.core.util.StrUtil;
import cn.hutool.extra.spring.SpringUtil;
import com.tianji.aigc.agent.AbstractAgent;
import com.tianji.aigc.agent.Agent;
import com.tianji.aigc.enums.AgentTypeEnum;
import com.tianji.aigc.enums.ChatEventTypeEnum;
import com.tianji.aigc.service.ChatService;
import com.tianji.aigc.vo.ChatEventVO;
import lombok.RequiredArgsConstructor;
import org.springframework.boot.autoconfigure.condition.ConditionalOnProperty;
import org.springframework.stereotype.Service;
import reactor.core.publisher.Flux;

@Service
@RequiredArgsConstructor
@ConditionalOnProperty(prefix = "tj.ai",name="chat-type",havingValue="ROUTE")

public class AgentServiceImpl implements ChatService {
    @Override
    public Flux<ChatEventVO> chat(String question,String sessionId){
        var result = this.findAgentByType(AgentTypeEnum.ROUTE).process(question,sessionId);
        // 大模型可能返回大小写/空白差异，统一处理后匹配，避免路由失败
        var agentTypeEnum = AgentTypeEnum.agentNameOf(StrUtil.isEmpty(result) ? null : StrUtil.trim(result).toUpperCase());
        var agent = this.findAgentByType(agentTypeEnum);
        if(agent==null){
            var chatEventVO = ChatEventVO.builder()
                    .eventType(ChatEventTypeEnum.DATA.getValue())
                    .eventData(result)
                    .build();
            return Flux.just(chatEventVO,AbstractAgent.STOP_EVENT);
        }
        return agent.processStream(question,sessionId);
    }

    /**
     * 根据代理类型查找对应的Agent实例
     *
     * @param agentTypeEnum 要查找的代理类型
     * @return 与给定类型匹配的Agent实例，如果未找到或类型为null则返回null
     */
    private Agent findAgentByType(AgentTypeEnum agentTypeEnum) {
        if (agentTypeEnum == null) {
            return null;
        }
        var beans = SpringUtil.getBeansOfType(Agent.class);
        // 遍历所有Agent Bean查找匹配类型
        for (var agent : beans.values()) {
            if (agentTypeEnum == agent.getAgentType()) {
                return agent;
            }
        }
        return null;
    }
    /**
     * 停止生成
     *
     * @param sessionId 会话ID
     */
    @Override
    public void stop (String sessionId){
        this.findAgentByType(AgentTypeEnum.ROUTE).stop(sessionId);
    }

    @Override
    public String chatText(String question) {
        return "";
    }

}

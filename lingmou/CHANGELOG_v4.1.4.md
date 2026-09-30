# 灵眸 v4.1.4 AutoX V7 优化

- 修正 MemoryManager 使用 maxMemory 作为使用率分母的问题，改为当前 Runtime 总分配内存，更符合 Android Rhino 实际监控。
- CacheManager 增强边界保护：限制异常小缓存容量和异常 TTL 配置。
- CacheManager 增加 stats()，便于 Monitor/PerfStats 读取缓存状态。
- 保持 AutoX V7 Rhino 兼容，不引入 Node API。

建议真机验证：长时间运行内存曲线、缓存增长、AutoX V7 线程回收。

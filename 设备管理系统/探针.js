/* ==================== 变量机制探针插件 ====================
 * 目的: 真机确认编辑器插件变量机制, 每个测试点一个 case, 日志打印结果。
 *
 * 准备: 编辑器全局变量 "测试2", 值随便填 (如 abc)
 *
 * 测试节点配置 (每个 case 建一个动作/条件节点):
 *   1. 动作-探针-读输入    输入变量: 测试输入 @测试2
 *      => 日志应显示 [abc] (@传值确认)
 *   2. 动作-探针-手打读    无输入变量
 *      => 日志显示手打 getValue('测试2') 能否读到值
 *   3. 动作-探针-写输出    输出变量: 测试输出 @测试2
 *      => 跑完看全局变量 测试2 是否被覆盖 (@输出覆盖确认)
 *   4. 动作-探针-手打写    无输出变量
 *      => 跑完看全局变量 手写变量 是否被创建
 *   5. 动作-探针-无返回    无变量
 *      => 看编辑器是否报"未返回数据" (数组点击 case 不 return 的兼容性)
 *   6. 动作-探针-点击      无变量
 *      => 注意屏幕会真点 (500,500) 区域中心, 确认 click("x,y,w,h") 全局函数可用
 * ================================================================ */

function setup() {
    console.log('探针插件初始化完成');
}

function loop(action) {
    try {
        switch (action) {
            case "动作类-探针-读输入": {
                var v = auto.getValue('测试输入');
                console.log('探针1 读输入变量 测试输入 => [' + (v === undefined ? 'undefined' : v) + ']');
                break;
            }
            case "动作类-探针-手打读": {
                var h = auto.getValue('测试2');
                console.log('探针2 手打 getValue(测试2) => [' + (h === undefined ? 'undefined' : h) + ']');
                break;
            }
            case "动作类-探针-写输出": {
                auto.setValue('测试输出', '探针写入' + (Date.now() % 10000));
                console.log('探针3 setValue(测试输出) 完成, 请检查全局变量 测试2 是否变化');
                break;
            }
            case "动作类-探针-手打写": {
                auto.setValue('手写变量', '手写测试' + (Date.now() % 10000));
                console.log('探针4 setValue(手写变量) 完成, 请检查变量列表是否新增 手写变量');
                break;
            }
            case "动作类-探针-无返回": {
                console.log('探针5 无return动作执行完成, 观察是否报 未返回数据');
                break;
            }
            case "动作类-探针-点击": {
                try {
                    click("500,500,100,100");
                    console.log('探针6 click(500,500,100,100) 执行成功');
                } catch (eC) {
                    console.log('探针6 click异常: ' + (eC && eC.message ? eC.message : eC));
                }
                break;
            }
            /* 标定: 在屏幕左边缘 x=55 依次点击 y=400/1200/2000 三点 (各停 2 秒),
             * 用指针工具记录每个落点的实际 y, 发回拟合 click 的 y 映射;
             * 输入变量 标定Y 填数字时只点该 y (区域 x=50,w=10,h=10) */
            case "动作类-探针-标定点击": {
                var dw = '', dh = '';
                try { dw = device.width; dh = device.height; } catch (eD) { dw = '未知'; }
                console.log('探针-标定: 屏幕 ' + dw + 'x' + dh);
                var ys = [400, 1200, 2000];
                var cy = parseInt(auto.getValue('标定Y') || '0', 10);
                if (cy > 0) ys = [cy];
                for (var yi = 0; yi < ys.length; yi++) {
                    try {
                        click('50,' + ys[yi] + ',10,10');
                        console.log('探针-标定: 已点击区域 50,' + ys[yi] + ',10,10 (期望中心 y=' + (ys[yi] + 5) + '), 2 秒后下一个');
                    } catch (eK) {
                        console.log('探针-标定: 点击异常 ' + (eK && eK.message ? eK.message : eK));
                    }
                    sleep(2);
                }
                break;
            }
            default:
                console.log('探针: 未知功能 ' + action);
                return false;
        }
    } catch (err) {
        console.log('探针异常: ' + (err && err.message ? err.message : err));
        return false;
    }
}

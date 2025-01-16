const fs = require('fs');
const path = require('path');
// 将js解析为抽象语法树
const babylon = require('babylon');
const babelTraverse = require('babel-traverse').default;
// 将抽象语法树转化为js代码
const generate = require('babel-generator').default;
const t = require('babel-types');
// 编译vue2模板
const compiler = require('vue-template-compiler');

const { initProps, initData, initComputed, initComponents } = require('./collect-state');
const { parseName, log, parseComponentName } = require('./utils');
const { 
    genImports, genConstructor,
    genStaticProps, genClassMethods
} = require('./react-ast-helpers');
const { 
    collectVueProps, handleCycleMethods, 
    handleGeneralMethods
} = require('./vue-ast-helpers');
const { genSFCRenderMethod } = require('./sfc/sfc-ast-helpers');

const output = require('./output');
const traverseTemplate = require('./sfc/index');

const state = {
    name: undefined,
    data: {},
    props: {},
    computeds: {},
    components: {}
};

// Life-cycle methods relations mapping
const cycle = {
    'created': 'componentWillMount',
    'mounted': 'componentDidMount',
    'updated': 'componentDidUpdate',
    'beforeDestroy': 'componentWillUnmount',
    'errorCaptured': 'componentDidCatch',
    'render': 'render'
};

const collect = { 
    imports: [],
    classMethods: {}
};

function formatContent (source, isSFC) {
    if (isSFC) {
        // 解析 .vue 文件内容，提取 <template>、<script> 和 <style> 部分
        const res = compiler.parseComponent(source, { pad: 'line' });
        return {
            template: res.template.content.replace(/{{/g, '{').replace(/}}/g, '}'),
            js: res.script.content.replace(/\/\//g, '')
        };
    } else {
        return {
            template: null,
            js: source
        };
    }
}

// AST for vue component
/**
 * 
 * @param {*} src 需要转换的文件路径
 * @param {*} targetPath 输出文件路径
 * @param {*} isSFC 是否是单文件组件
 */
module.exports = function transform (src, targetPath, isSFC) {
    // 同步读取文件
    const source = fs.readFileSync(src);
    const component = formatContent(source.toString(), isSFC);

    // 将 <script> 中的代码解析为 AST
    const vast = babylon.parse(component.js, {
        sourceType: 'module',
        plugins: isSFC ? [] : ['jsx']
    });

    // 从抽象语法树提取信息
    initProps(vast, state);
    initData(vast, state);
    initComputed(vast, state);
    initComponents(vast, state); // SFC

    babelTraverse(vast, {
        ImportDeclaration (path) {
            collect.imports.push(path.node);
        },
    
        ObjectMethod (path) {
            const name = path.node.key.name;
            if (path.parentPath.parent.key && path.parentPath.parent.key.name === 'methods') {
                handleGeneralMethods(path, collect, state, name);
            } else if (cycle[name]) {
                handleCycleMethods(path, collect, state, name, cycle[name], isSFC);
            } else {
                if (name === 'data' || state.computeds[name]) {
                    return;
                }
                log(`The ${name} method maybe be not support now`);
            }
        }
    });

    let renderArgument = null;
    if (isSFC) {
        // traverse template in sfc
        renderArgument = traverseTemplate(component.template, state);
    }
    
    // AST for react component
    const tpl = `export default class ${parseName(state.name)} extends Component {}`;
    // react 抽象语法树 后续继续构造
    const rast = babylon.parse(tpl, {
        sourceType: 'module'
    });
    
    babelTraverse(rast, {
        Program (path) {
            genImports(path, collect, state);
        },
    
        ClassBody (path) {
            genConstructor(path, state);
            genStaticProps(path, state);
            genClassMethods(path, collect);
            isSFC && genSFCRenderMethod(path, state, renderArgument);
        }
    });

    if (isSFC) {
        // replace custom element/component
        babelTraverse(rast, {
            ClassMethod (path) {
                if (path.node.key.name === 'render') {
                    path.traverse({
                        JSXIdentifier (path) {
                            if (t.isJSXClosingElement(path.parent) || t.isJSXOpeningElement(path.parent)) {
                                const node = path.node;
                                const componentName = state.components[node.name] || state.components[parseComponentName(node.name)];
                                if (componentName) {
                                    path.replaceWith(t.jSXIdentifier(componentName));
                                    path.stop();
                                }
                            }
                        }
                    });
                }
            }
        });
    }
    
    const { code } = generate(rast, {
        quotes: 'single',
        retainLines: true
    });
    
    output(code, targetPath);
    log('Transform successed!!!', 'success');
};

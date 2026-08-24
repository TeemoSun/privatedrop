# 推送到 GitHub 流程

privatedrop 托管在 GitHub（私有仓库）：https://github.com/TeemoSun/privatedrop

## 前置条件

1. 已安装 [GitHub CLI](https://cli.github.com/) 并登录：`gh auth status`（或已配置 SSH key：`git remote -v` 检查）。
2. 已在仓库根目录（`git remote -v` 输出含 `origin`）。

## 日常提交推送

```bash
# 查看待提交改动
git status && git diff

# 暂存并提交（提交信息风格：feat/fix/docs 前缀 + 中文描述，参考历史 git log）
git add <files>
git commit -m "feat: 描述本次改动"

# 推送到 GitHub（main 分支已跟踪 origin/main）
git push
```

## 首次初始化仓库（新项目）

项目已初始化过（`origin` 指向 `git@github.com:TeemoSun/privatedrop.git`）。若需在全新目录重建：

```bash
# 方式一：本地已有仓库，创建远端（私有）并推送
gh repo create privatedrop --private --source . --push

# 方式二：克隆已有远端
git clone git@github.com:TeemoSun/privatedrop.git
```

## 常用操作

```bash
gh repo view TeemoSun/privatedrop        # 查看仓库信息/可见性
git pull                                 # 拉取远端更新
git log --oneline -10                    # 查看最近提交
```

> 约定：仓库保持 **private**；提交前检查不纳入版本控制的文件（`.env`、`data/`、`frontend/dist/`、`backend/app/static/`，见 `.gitignore`）。

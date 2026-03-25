import json
import semver
import subprocess

import subprocess
import re
import sys

def call(cmd, cwd=None):
    input(f"Will execute: [{cwd or '.'}]" + subprocess.list2cmdline(cmd))
    return subprocess.call(cmd, shell=True, cwd=cwd)



def bump():

    with open("./node_modules/kipphi/package.json", "r", encoding="utf-8") as f:
        kipphi_package_json = json.load(f)


    with open("./package.json", "r", encoding="utf-8") as f:
        package_json = json.load(f)
        print("当前package.json：", package_json)

    with open("./render/package.json", "r", encoding="utf-8") as f:
        render_package_json = json.load(f)
        print("当前render/package.json：", render_package_json)
    print(f"kipphi版本：{kipphi_package_json['version']}")
    print(f"当前本包版本：{package_json['version']}")
    print("已将本包依赖kipphi版本升级为最新版本")
    package_json['dependencies']['kipphi'] = kipphi_package_json['version']
    render_package_json['dependencies']['kipphi'] = kipphi_package_json['version']

    ver = input("请输入新版本号，留空则直接使用kipphi版本号：")
    ver = ver if ver else kipphi_package_json['version']
    ver2 = input("请输入kpp-render的版本号，留空则直接使用kipphi-player版本号：")
    ver2 = ver2 if ver2 else kipphi_package_json['version']
    package_json['version'] = ver
    render_package_json['version'] = ver2

    with open("./package.json", "w", encoding="utf-8") as f:
        json.dump(package_json, f, indent=4, ensure_ascii=False)
    with open("./render/package.json", "w", encoding="utf-8") as f:
        json.dump(render_package_json, f, indent=4, ensure_ascii=False)
    
    print(f"已将本包版本号升级为{ver}")

    print("提交到Git？")
    call(["git", "add", "./package.json", "./render/package.json"])
    call(["git", "commit", "-m", f"chore: bump to {ver}"])
    call(["git", "push"])

def send_to_npm():
    print("发布到NPM")
    print("先build一下")
    call(["bun", "run", "build/build"], ".")
    # call(["npm", "run", "build"], ".")
    call(["npm", "publish", "--registry", "https://registry.npmjs.org/", "--dry"], ".")
    print("请确认刚刚的输出是否正确")
    call(["npm", "publish", "--registry", "https://registry.npmjs.org/"], ".")

    print("发布kpprender")
    yn = input("请确认是否发布kpprender？")
    if yn == "n":
        return
    call(["npm", "publish", "--registry", "https://registry.npmjs.org/", "--dry"], "./render")
    print("请确认刚刚的输出是否正确")
    call(["npm", "publish", "--registry", "https://registry.npmjs.org/"], "./render")


if __name__ == "__main__":
    if len(sys.argv) > 1 and sys.argv[1] == "npm":
        send_to_npm()
        exit(0)
    bump()


    
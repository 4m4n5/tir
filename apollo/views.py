from django.contrib.auth import get_user_model, login, logout
from django.contrib.auth.decorators import login_required
from django.contrib.auth.forms import AuthenticationForm, UserCreationForm
from django.urls import reverse
from django.shortcuts import render, redirect
import json
from apollo.models import *

User = get_user_model()
# Create your views here.
@login_required(login_url='/log_in/')
def user_list(request):
    users = User.objects.select_related('logged_in_user')
    for user in users:
        user.status = 'Online' if hasattr(user, 'logged_in_user') else 'Offline'
    return render(request, 'apollo/user_list.html', {'users': users})

def log_in(request):
    form = AuthenticationForm()
    if request.method == 'POST':
        form = AuthenticationForm(data=request.POST)
        if form.is_valid():
            login(request, form.get_user())
            return redirect(reverse('apollo:user_list'))
        else:
            print(form.errors)
    return render(request, 'apollo/log_in.html', {'form': form})

@login_required(login_url='/log_in/')
def log_out(request):
    logout(request)
    return redirect(reverse('apollo:log_in'))

def sign_up(request):
    form = UserCreationForm()
    if request.method == 'POST':
        form = UserCreationForm(data=request.POST)
        if form.is_valid():
            form.save()
            p = Player(name=request.POST['username'])
            p.save()
            return redirect(reverse('apollo:log_in'))
        else:
            render(request, 'apollo/sign_up.html', {'error': form.errors, 'form': form})
    return render(request, 'apollo/sign_up.html', {'error': form.errors, 'form': form})
